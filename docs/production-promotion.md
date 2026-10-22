# Protected production promotion

`.github/workflows/production-promotion.yml` is the only routine repository automation authorized
to promote the managed production stack. It is manual-only (`workflow_dispatch`), has no push, tag,
pull-request, schedule, or workflow-chain trigger, and never bootstraps resources or writes runtime
secrets. Adding it does not deploy anything. It has not been run, so this repository claims no
production deployment evidence.

The workflow deliberately separates two immutable inputs:

- `automation/` is the reviewed workflow commit from the default branch (`github.sha`). Every policy
  command runs from this checkout, so an older candidate cannot weaken current promotion policy.
- `release/` is the exact 40-character staging-qualified commit. Builds and provider CLI commands
  use this checkout, so the default branch cannot silently replace the candidate.

Cloudflare Worker versions are service/environment-specific and the current Container configuration
uses `rollout_step_percentage: 100` with one `standard-1` instance. The workflow therefore does not
claim byte-for-byte cross-environment Worker version promotion or a Container canary. It rebuilds
the exact reviewed deploy inputs from the immutable commit, checks their source-artifact SHA-256
identities against staging evidence, and puts separate protected operator checkpoints before the
read-only preflight, private-plane mutation, public-edge mutation, and postflight. A successful CLI
exit is never described as a canary.

## Required GitHub environment

Create a `production` environment before enabling this workflow. Switch **prevent self-review on**
and list only reviewers who are not the person dispatching, disable administrator bypass, and
restrict deployments to the default branch.

An earlier revision of this document asked for "at least two reviewers" and implied that produced
two-person control. It does not: GitHub proceeds as soon as **one** of the listed reviewers
approves, so a longer list adds availability, not scrutiny. The only setting that guarantees someone
other than the dispatcher approved is prevent-self-review, which is why it is mandatory here and
optional on the staging environments. This is the one irreversible boundary in the system, so it is
also the one place a second person is genuinely required.
The four protected jobs intentionally request the same environment separately; reviewers must check
the completed prior phase before admitting the next credential-bearing job.

Configure only these environment secrets:

| Secret | Narrow purpose |
| --- | --- |
| `CLOUDFLARE_PRODUCTION_API_TOKEN` | Production Workers/Containers deploy, Queue/R2 read, and Worker-secret-name read for the named account only |
| `CLOUDFLARE_PRODUCTION_ACCOUNT_ID` | Exact production Cloudflare account |
| `CONVEX_PRODUCTION_DEPLOY_KEY` | Exact production Convex deployment only |

Configure these environment variables:

| Variable | Meaning |
| --- | --- |
| `NEXT_CODER_STAGING_URL` | Exact qualified staging HTTPS origin |
| `NEXT_CODER_PRODUCTION_URL` | Exact production HTTPS origin |
| `NEXT_CODER_PRODUCTION_MEDIA_BUCKET` | Pre-provisioned production media bucket name |
| `NEXT_CODER_PRODUCTION_FIRMWARE_BUCKET` | Pre-provisioned production firmware bucket name |

The workflow's top-level permission is `contents: read` plus `actions: read` for the exact
same-repository evidence download. It does not request OIDC, package, pull-request, or status write.
Provider credentials are step-scoped and subprocess-scoped: Git receives no provider credential,
Wrangler receives only the two Cloudflare values, and Convex receives only its deploy key.

## Promotion evidence bundle

Before dispatch, collect one reviewed, flat GitHub artifact from the same repository containing:

1. `promotion-manifest.json`;
2. the passing staging release artifact (`next-coder.staging-release.v1`, operation `deploy`);
3. the passing staging qualification artifact (`next-coder.staging-qualification.v1`);
4. a reviewed hosted-capacity decision (`next-coder.staging-capacity.v1`); and
5. a reviewed staging security/drill record (`next-coder.staging-security.v1`).

Each document needs `result: "passed"` and `finishedAt`. Release, capacity, and security records also
need the exact `targetCommit`; qualification needs `target.origin` equal to the configured staging
origin. Capacity and security records are operator attestations produced only after the hosted
matrices in [capacity SLO](capacity-slo.md), [staging qualification](staging-qualification.md),
[production security](production-security.md), and [cloud observability](cloud-observability.md) have
actually run. Local tests are not acceptable substitutes.

The manifest is intentionally small:

```json
{
  "schema": "next-coder.staging-promotion-manifest.v1",
  "targetCommit": "<40-character SHA>",
  "createdAt": "2026-08-27T20:00:00.000Z",
  "artifacts": {
    "console": "<64-character SHA-256>",
    "edge": "<64-character SHA-256>",
    "controlPlane": "<64-character SHA-256>",
    "container": "<64-character SHA-256>",
    "convex": "<64-character SHA-256>"
  },
  "evidence": {
    "release": { "file": "staging-release-evidence.json", "sha256": "<SHA-256>" },
    "qualification": { "file": "staging-qualification-evidence.json", "sha256": "<SHA-256>" },
    "capacity": { "file": "staging-capacity-evidence.json", "sha256": "<SHA-256>" },
    "security": { "file": "staging-security-evidence.json", "sha256": "<SHA-256>" }
  }
}
```

Generate the five deterministic tracked-source identities from a clean checkout of the candidate:

```bash
npm run production:artifact-digests
```

The identities cover the actual tracked deploy inputs per surface: frontend/root build inputs,
edge Worker plus frontend, private Worker configuration/source, Container Docker/runtime plus `src/`,
and Convex/root build inputs. The protected workflow recomputes them from the candidate checkout and
refuses any mismatch. Compute each evidence-file SHA-256 over its exact bytes, write the manifest,
then compute and independently review the exact lowercase SHA-256 of the manifest itself. The
workflow accepts only safe flat filenames and evidence no older than 72 hours. Do not include
tokens, account IDs, raw Worker version IDs, URLs with credentials, user data, or provider output.

## Before dispatch

Record without exposing provider credentials or resource identifiers:

- exact target and currently active production source commits;
- exact single active 100%-traffic edge and control-plane Worker version IDs;
- same-repository evidence workflow run ID, artifact name, and reviewed manifest SHA-256;
- passing repository secret gate for the target;
- current production Convex backup reference held outside the workflow;
- reviewer conclusion that the target is backward compatible with the currently active release.

Dispatch from the default branch and enter:

```text
promote:production:<target-commit>:<manifest-sha256>
```

The target and current commits must both be on the default branch and the target must be a forward
descendant. The candidate checkout must equal the target. Promotion fails closed if the `convex/`
tree differs or either Durable Object migration history differs, because this generic workflow
cannot promise an automatic rollback across a durable compatibility boundary.

## Checkpoints and dependency order

The protected read-only preflight verifies the claimed active versions and their exact source-commit
deployment annotations, production dry-runs, reciprocal Service Bindings and named entrypoint,
Durable Object parity, Queue/Cron/retry/DLQ topology, the configured Container shape, all three named
Queues, both configured R2 buckets, required Worker-secret names, and the Convex secret name. It
never creates a missing dependency.

After a reviewer approves each boundary, mutation is serialized:

1. Convex deploy;
2. private control-plane Worker plus immediate single-Container rollout;
3. operator confirms the private plane moved while the public edge did not;
4. public edge Worker plus Static Assets;
5. both active commit annotations and the credential-free production boundary are checked.

If any step fails, stop. Do not approve the next job merely because the previous provider command
returned successfully. Inspect the provider state, staging evidence, and redacted workflow artifact.

## Rollback and removal limits

There is no automatic rollback, production bootstrap, resource deletion, secret mutation, Convex
data restore, Worker-version yank, or Container image deletion in this workflow. Cloudflare
Container deploys are not transactional, and Convex functions/data plus Durable Object migrations
cannot safely be rewound from a generic script.

The fail-closed templates in `cloudflare/bootstrap/production-edge-stub.ts` and
`cloudflare/bootstrap/wrangler.production.jsonc` are retained for an explicitly reviewed first-install
plan. They expose no public route, have no credentials, and return only `503` failures. The promotion
workflow does not deploy them. Never install a bootstrap stub over a working production edge.

The preflight's strict compatibility rule makes the immediately prior release a plausible recovery
candidate, not an automatically safe one. For rollback, stop the promotion, identify which phases
actually changed, take a new backup, re-qualify the exact prior commit against the current durable
state, and use an incident-specific reviewed plan. If Convex source or DO migrations differ, a data
or migration recovery plan is mandatory. Deleting/yanking resources is a separate destructive
operation requiring explicit authorization.

## Evidence and local verification

Each mutation/postflight job uploads only `next-coder.production-promotion.v1`: commit IDs,
the manifest hash, fixed check names, bounded error codes, timestamps, and rollout mode. It excludes
raw version/resource IDs, provider output, errors/stacks, origins, and secret values. Failed
preflight may produce no artifact because no mutation occurred; GitHub job logs remain subject to
the same redaction discipline.

These checks are hermetic and do not contact Cloudflare, Convex, npm, staging, or production:

```bash
npm run test:production-promotion
npm run test:workflow
npm run security:repo
```

`npm run production:validate-promotion` performs Git/evidence/config validation for a fully supplied
local context. Protected `preflight`, execution, and postflight modes perform remote reads or writes
and must be run through the reviewed workflow, not ad hoc.
