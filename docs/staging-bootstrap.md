# Protected first-time staging bootstrap

`.github/workflows/staging-bootstrap.yml` is the only repository automation authorized to create
the first managed staging stack. It is manual-only (`workflow_dispatch`), uses the separately
protected GitHub `staging-bootstrap` environment, pins both the trusted automation commit and the
requested source commit, and has no push or pull-request trigger. Adding this workflow does not run
it and does not provision any external resource.

This is a one-time bootstrap and recovery procedure, not the normal release path. Once it finishes,
use the protected [`Staging release`](staging-release.md) workflow for all deploys and rollbacks.

## Protect and scope the environment

Create a GitHub environment named exactly `staging-bootstrap`. Require reviewers, restrict deployment branches to the repository default branch, and prevent environment
administrators from bypassing the rules. Do not reuse the normal `staging` environment: bootstrap
has resource-creation and secret-provisioning authority that routine releases do not need.

**Reviewer policy.** "Prevent self-review" is optional and defaults to off, so a solo maintainer can
be the sole required reviewer here and approve their own dispatch; the run still halts and waits for
a deliberate click. Note also that when several reviewers are listed, GitHub proceeds once *one* of
them approves, so extra names do not create two-person control. See
[operator-setup.md](operator-setup.md) for the settings this project actually uses.

Use an account isolated from production. The Cloudflare token must be limited to that staging
account and only the Workers/Containers, Queues, R2, and read capabilities needed by the procedure.
The Convex deploy key must name only the staging deployment. The workflow refuses known production
service, Queue, and derived bucket names, but account-level isolation remains the primary boundary.

Configure these non-secret environment variables:

| Variable | Meaning |
| --- | --- |
| `NEXT_CODER_STAGING_URL` | Exact future staging HTTPS origin, without a path or trailing slash |
| `NEXT_CODER_STAGING_MEDIA_BUCKET` | Unique bucket name ending in `-staging` |
| `NEXT_CODER_STAGING_FIRMWARE_BUCKET` | A different unique bucket name ending in `-staging` |

Configure these environment secrets:

| Secret | Minimum purpose |
| --- | --- |
| `CLOUDFLARE_BOOTSTRAP_API_TOKEN` | Staging-account bootstrap token; never production-scoped |
| `CLOUDFLARE_STAGING_ACCOUNT_ID` | Exact isolated staging account |
| `CONVEX_STAGING_DEPLOY_KEY` | Exact staging Convex deployment |
| `STAGING_RUNTIME_PUBLIC_BASE_URL` | Container `PUBLIC_BASE_URL` |
| `STAGING_RUNTIME_CONVEX_URL` | Container `CONVEX_URL` |
| `STAGING_RUNTIME_GATEWAY_CONVEX_SECRET` | Shared Container/Convex gateway secret |
| `STAGING_RUNTIME_CLERK_SECRET_KEY` | Staging Clerk secret key |
| `STAGING_RUNTIME_CLERK_PUBLISHABLE_KEY` | Matching staging Clerk publishable key |
| `STAGING_RUNTIME_T3_TOKEN_ENCRYPTION_KEY` | Staging T3-token encryption key |
| `STAGING_RUNTIME_S3_ENDPOINT` | Staging R2 S3 endpoint |
| `STAGING_RUNTIME_S3_BUCKET` | Must identify the configured media bucket |
| `STAGING_RUNTIME_FIRMWARE_S3_BUCKET` | Must identify the configured firmware bucket |
| `STAGING_RUNTIME_S3_ACCESS_KEY_ID` | Staging-only R2 access key |
| `STAGING_RUNTIME_S3_SECRET_ACCESS_KEY` | Matching staging-only R2 secret |
| `STAGING_RUNTIME_WEB_PUSH_VAPID_KEYS` | Managed staging Web Push VAPID key set |
| `STAGING_RUNTIME_WEB_PUSH_STORAGE_ENCRYPTION_KEY` | Staging push-subscription sealing key |

All credentials and application values are scoped to the single mutation step after environment
approval. The orchestrator passes Cloudflare credentials only to Wrangler and the Convex key only to
Convex. Application secrets are sent to `wrangler secret bulk` or `convex env set` on standard input;
they are never command arguments, resource names, artifacts, or command output. Git and the
credential-free qualification receive no deployment credential.

The shared `GATEWAY_CONVEX_SECRET` value must be entered in the corresponding Cloudflare and Convex
environment secrets. Neither provider exposes stored values for comparison, so the provisioning
record—not a read-back—is the evidence that they match.

## Exact resources and dependency order

The procedure creates or verifies exactly these Queues:

- `agent-controller-connector-events-staging`
- `agent-controller-background-staging`
- `agent-controller-dead-letter-staging`

It also creates the two R2 buckets named by the protected variables. It rejects unexpected
`agent-controller-*-staging` Queues or buckets instead of guessing whether they belong to this stack.

The edge and private control plane have reciprocal Service Bindings, so bootstrap is ordered:

1. Create the three Queues and two R2 buckets.
2. Deploy `agent-controller-cloud-staging` from `cloudflare/bootstrap/wrangler.staging.jsonc`. This
   stub has no route, `workers.dev`, preview URL, Static Assets, Durable Object, Queue, or
   control-plane binding and every request/RPC fails with `503 staging_bootstrap_incomplete`.
3. Deploy `agent-controller-control-plane-staging` privately with Container rollout disabled, bound
   to that named stub.
4. Provision only the required private-Worker secret names through standard input.
5. Provision the matching Convex gateway secret through standard input, then deploy Convex.
6. Deploy the final private Worker and immediate Container rollout.
7. Deploy the final edge Worker and Static Assets, replacing the non-public stub.
8. Re-read exact resources, deployments, secret names, and Convex environment names, then run the
   credential-free public/private-boundary qualification.

The final Worker deployment messages use `next-coder staging deploy <commit>`, which is the
normal release workflow's source-of-truth convention. The bootstrap never adds a public route to the
stub, and it never creates a partially functional public edge.

## Dispatch, resume, and abort

Dispatch from the repository default branch and use a full 40-character source commit that is
already reachable from that branch. Choose a stable operator ticket for `bootstrap_id` and record it
outside artifacts and logs. For a fresh empty account select `bootstrap`, leave both current Worker
versions blank, and enter:

```text
bootstrap:staging:<40-character-target-commit>:<bootstrap-id>
```

The fresh operation refuses any pre-existing target Queue, bucket, edge Worker, or private Worker.
If an action fails, there is no automatic rollback: preserve the evidence artifact, inspect the
provider state, and dispatch `resume` with the same source commit and bootstrap ID plus the exact
currently active edge and private-control-plane version IDs. Confirm:

```text
resume:staging:<40-character-target-commit>:<bootstrap-id>
```

Resume is idempotent only for resources and deployment annotations owned by that exact bootstrap.
It skips already-created resources and completed stages. It fails closed if an active version changed,
an annotation differs, a production or mismatched resource is visible, the final edge exists without
the final private Worker, or provider inventory is ambiguous. Do not start a new bootstrap ID over a
partial stack.

`abort_cleanup` is intentionally narrow. It is allowed only while the exact fail-closed edge stub
exists and no private control-plane Worker has ever been created. Supply the stub's exact active edge
version and the same source/bootstrap ID, then confirm:

```text
abort_cleanup:staging:<40-character-target-commit>:<bootstrap-id>
```

That operation deletes only the owned stub and any of the three named Queues/two named buckets it
finds. It never deletes a private Worker, Container, Durable Object, Convex deployment, Convex data,
secret, production resource, or unrecognized staging resource. After the private control plane
exists, cleanup requires a separately reviewed incident plan because Durable Object/Convex/Container
state may already be durable. Emptying a non-empty R2 bucket or destructive provider recovery is
also outside this workflow.

## Evidence and proof boundary

The workflow always attempts to upload `staging-bootstrap-evidence.json` with schema
`next-coder.staging-bootstrap.v1`. It records fixed phase names, bounded outcomes/durations,
source commits, and hashed resource references. It excludes account IDs, resource names, Worker
version IDs, bootstrap IDs, provider output, errors/stacks, configuration bodies, and all secret
values.

A passing artifact proves only that the named bootstrap orchestration and credential-free boundary
checks completed. It is not proof of hosted Queue delivery/DLQ behavior, R2 access, Convex data
semantics, connector/T3 operation, Web Push provider delivery, rollover, capacity, WAN behavior, or
hardware TLS. Collect those separately through [staging qualification](staging-qualification.md) and
[capacity SLO](capacity-slo.md).

Hermetic validation never calls Cloudflare, Convex, or a staging origin:

```bash
npm run staging:validate-bootstrap
npm run test:workflow
```

`npm run staging:bootstrap` performs remote reads and mutations. Operators should use the protected
workflow rather than running it ad hoc. No bootstrap has been executed from this repository at the
time this runbook was added.
