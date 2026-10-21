# Protected staging release and rollback

`.github/workflows/staging-release.yml` is the only repository automation authorized to mutate the
managed staging stack. It is manual-only (`workflow_dispatch`), targets the protected GitHub
`staging` environment, checks out an exact commit rather than a moving branch, and never runs on a
push or pull request. Adding the workflow does not deploy or provision anything.

The workflow assumes an isolated staging account has already been bootstrapped. It deliberately
does not create Workers, Queues, R2 buckets, routes, Convex deployments, or secrets. First-time
provisioning uses the separately protected, manual-only [staging bootstrap](staging-bootstrap.md),
which breaks the reciprocal Service Binding cycle with a non-public fail-closed edge stub before it
deploys the private control plane and final edge. Until both named services and all resources exist,
this release workflow's read-only preflight fails and no mutation starts.

## GitHub environment setup

Protect the `staging` environment with required reviewers, restrict deployment
branches to the repository's default branch, and keep environment administrators from bypassing the
rules. The repository workflow also verifies the dispatch ref and both source commits against the
default branch, but repository settings remain the authority that withholds credentials before
approval.

**Reviewer policy.** "Prevent self-review" is optional and defaults to off, so a solo maintainer can
be the sole required reviewer here and approve their own dispatch; the run still halts and waits for
a deliberate click. Note also that when several reviewers are listed, GitHub proceeds once *one* of
them approves, so extra names do not create two-person control. See
[operator-setup.md](operator-setup.md) for the settings this project actually uses.

Configure only these staging environment secrets:

| Secret | Minimum purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Account-scoped staging token with Workers/Containers and Queues write plus R2 read; no production resources |
| `CLOUDFLARE_ACCOUNT_ID` | Exact account selected for the isolated staging resources |
| `CONVEX_DEPLOY_KEY` | Deploy key tied only to the staging Convex deployment |

Configure these non-secret environment variables:

| Variable | Meaning |
| --- | --- |
| `NEXT_CODER_STAGING_URL` | Exact HTTPS origin, with no path or trailing slash |
| `NEXT_CODER_STAGING_MEDIA_BUCKET` | Expected staging media R2 bucket name |
| `NEXT_CODER_STAGING_FIRMWARE_BUCKET` | Expected staging firmware R2 bucket name |

The workflow never puts a secret in an argument, repository file, artifact name, or log command. The
three secrets are step-scoped only after the credential-free candidate gate and environment
approval. Subprocess environments are then provider-scoped: Git receives no deployment credential,
Wrangler receives only the Cloudflare token and account ID, and Convex receives only its deploy key.
Runtime application values remain pre-provisioned Cloudflare Worker secrets. The
preflight reads names—not values—and requires:

`PUBLIC_BASE_URL`, `CONVEX_URL`, `GATEWAY_CONVEX_SECRET`, `CLERK_SECRET_KEY`,
`CLERK_PUBLISHABLE_KEY`, `T3_TOKEN_ENCRYPTION_KEY`, `S3_ENDPOINT`, `S3_BUCKET`,
`FIRMWARE_S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `WEB_PUSH_VAPID_KEYS`, and
`WEB_PUSH_STORAGE_ENCRYPTION_KEY`.

The VAPID key set and subscription-sealing key are pre-provisioned application secrets, not secrets
used by this routine release workflow. The one-time bootstrap supplies them from its separately
protected GitHub environment and provisions them only over standard input. Release preflight reads
only their names from Cloudflare; neither workflow puts their values in command arguments, logs, or
deployment evidence.

The Convex deployment must separately contain `GATEWAY_CONVEX_SECRET`. Its value must match the
Cloudflare secret, but neither platform exposes secret values for comparison; provisioning and
rotation records are the evidence for that equality.

## Before dispatch

The operator records all of the following without copying tokens, account identifiers, bucket names,
or user data into the release ticket:

1. the exact candidate commit SHA and the exact source commit currently deployed;
2. the single active 100%-traffic edge Worker version ID;
3. the single active 100%-traffic control-plane Worker version ID;
4. the passing `Hermetic CI` run for the candidate;
5. the reviewed Convex dry-run, including confirmation that schema/index changes are backward
   compatible with both the old and new Container during the release window;
6. a current Convex backup when the release changes durable schema or data interpretation.

Dispatch the workflow from the default branch. Select `deploy`, enter the two commits and two active
version IDs, then enter this exact confirmation:

```text
deploy:staging:<40-character-target-commit>
```

The workflow checks the target is a descendant of the currently deployed commit. A force-pushed,
off-branch, dirty, abbreviated, or mismatched checkout fails before credentials are available.

## What preflight proves

The protected job repeats the current deployment status immediately before mutation and refuses a
split deployment, version mismatch, or deployment message that does not bind both services to the
claimed current source commit. This prevents an operator from overwriting an intervening release or
misidentifying the rollback base. The bootstrap procedure must therefore use the same
`next-coder staging deploy <commit>` deployment-message convention. It also performs:

- Convex, edge Worker, and private control-plane dry-runs;
- append-only Durable Object migration validation;
- exact reciprocal Service Binding and named-entrypoint validation;
- exact staging Queue producer/consumer, retry, broker-DLQ, and Cron validation;
- exact per-runtime Analytics Engine binding plus bounded custom-log/trace sampling validation, with
  automatic invocation logs required off;
- existence checks for all three Queues and both named R2 buckets through read-only Cloudflare APIs;
- application Worker-secret-name and Convex-environment-name checks;
- release Container configuration validation (`linux/amd64` is independently enforced by the
  Container smoke; staging remains `standard-1`, one instance, immediate rollout);
- the complete credential-free repository, cloud, connector-package, Container, and release-harness
  gates from the pinned checkout.

The preflight cannot prove that two opaque secrets have equal values, that an R2 credential can read
or write the intended bucket, or that Convex/R2/Queue behavior is live. Analytics Engine datasets are
created on their first hosted write, so configuration validation also does not prove ingestion,
schema privacy, queries, dashboards, or alert delivery. Those are post-deploy staging tests and must
not be inferred from a passing resource-name check. Follow [Cloud observability](cloud-observability.md)
for the hosted evidence procedure.

## Dependency-safe deployment

For a forward release, mutation is serialized:

1. deploy Convex functions/schema from the pinned candidate;
2. deploy the private control-plane Worker and rebuild/roll out its Container immediately;
3. deploy the public edge Worker and Static Assets;
4. run the credential-free public-boundary qualification.

This order lets the new private control plane talk to the still-active old edge contract before the
new edge begins calling it. Both sides must remain one-release backward compatible. Cloudflare
Container deploys are not transactional: the Worker activates before the image rollout finishes.
The workflow therefore waits for the old edge to traverse the newly deployed Service Binding and
Container before changing the edge, then repeats the full credential-free boundary qualification
after the edge deploy. Both probes are bounded. Any failed stage is a failed release; a command
success alone never proves the Container is ready.

No automatic rollback runs after a failure. An automatic reversal could cross a Durable Object or
Convex compatibility boundary without a human seeing which mutation completed. The redacted evidence
artifact records the last observed component versions so an operator can choose the explicit
rollback path.

## Explicit rollback

Dispatch the same workflow from the default branch with `rollback`. The target must be an older
ancestor of the currently deployed source commit. Supply the active version IDs observed after the
failed/current release and confirm:

```text
rollback:staging:<40-character-target-commit>
```

Rollback is a full deploy from that exact source commit, not `wrangler rollback`: a Worker-version
rollback does not by itself rebuild and restore the previous Container image/configuration. The
workflow restores the edge first, then the private control-plane Worker and Container. It does not
rewind Convex data or functions.

To fail closed, rollback is rejected if the two commits differ in any of these areas:

- the entire `convex/` tree;
- either Durable Object migration history;
- staging Durable Object, Service Binding, Queue, Cron, or Container topology.

If one differs, use an incident-specific recovery plan. For Convex, take a fresh backup before any
destructive restore; a data restore, environment-variable restore, and code restore are separate
operations. For Durable Objects or deleted platform resources, Cloudflare may reject old Worker
versions and operator reconstruction may be required.

## Evidence

The workflow always attempts to upload `staging-release-evidence.json` with schema
`next-coder.staging-release.v1`. It contains source/automation commits, fixed stage names,
bounded failure codes, durations, dependency order, SHA-256 references for Worker version IDs, and
the already-redacted credential-free qualification result. It excludes raw version IDs, account and
bucket identifiers, Cloudflare/Convex command output, errors, stacks, configuration bodies, and every
secret value.

Store the artifact with the release record. A passing artifact proves only the named deploy and
public-boundary checks. Complete the hosted telemetry/privacy/alerts, Queue/DLQ, Convex/R2,
connector/T3, rollover, capacity, WAN, and hardware evidence in
[staging qualification](staging-qualification.md), [cloud observability](cloud-observability.md), and
[capacity SLO](capacity-slo.md) before promoting the candidate.

## Hermetic verification

The static and pure command-construction tests never call Cloudflare, Convex, or the staging origin:

```bash
npm run test:workflow
npm run test:staging-release
npm run test:staging-qualification
```

`test:workflow` is the exact aggregate used by both credential-free CI and the protected automation
checkout. It includes the CI policy, frontend-budget analyzer, staging qualification, and staging
release tests; the two narrower commands remain useful while iterating.

Local validation of a real release context is available through `npm run staging:validate-release`.
`npm run staging:preflight` performs remote reads, and `npm run staging:release` mutates staging;
operators should use the protected workflow rather than running the latter two ad hoc.
