# Operator setup: from nothing to a qualified staging stack

This is the single ordered sequence for [completion plan](../roadmap/completion-plan.md) Phase 1
(accounts, environments, secrets) and Phase 2 (first staging deployment). It exists because those
values are otherwise spread across five runbooks that each describe one slice, and a single wrong
secret name burns a reviewer-gated workflow run and can leave half-created cloud resources.

Nothing in this repository has ever been deployed, published, or provisioned. Every command below
is written to be run for the first time. The runbooks remain authoritative for *why* each control
exists; this document is authoritative for *order* and for the exact names:

- [Protected first-time staging bootstrap](staging-bootstrap.md)
- [Protected staging release and rollback](staging-release.md)
- [Staging qualification](staging-qualification.md)
- [Protected npm connector release](npm-connector-release.md)
- [Protected production promotion](production-promotion.md)
- [Notifications and background liveness](notifications.md)
- [Clerk and Convex authentication](auth-storage.md)

**Where a runbook and the workflow that consumes a value disagree, the workflow wins.** The
disagreements found while writing this document are listed in
[Appendix C](#appendix-c--known-runbook-versus-workflow-disagreements), and this document already
follows the workflow.

## How to read this

| Marker | Meaning |
| --- | --- |
| **Decision** | You must choose. The default recorded in the completion plan is given. |
| **Verify** | Run this before starting the next stage. A stage is not finished until its verification passes. |
| **Recovery** | What partial state this stage can leave and how to get out of it. |

Placeholders are written in capitals (`REPLACE_WITH_...`, `<40-character-commit>`) and are never
real values. Set these two shell variables once; every `gh` command below uses them:

```bash
REPO='Wearer-Lab/next-coder'   # adjust if you forked or renamed
BRANCH='main'                        # the repository default branch
```

---

## Stage 0 — Repository preconditions

Do not start Stage 1 until completion plan Phase 0 is done, in particular:

- the license is ratified (Apache-2.0 is in place at `LICENSE` and `packages/connector/LICENSE`);
- every credential that was ever tracked has been rotated;
- the repository is public, with private vulnerability reporting on, branch protection on the
  default branch requiring the `Hermetic CI` checks, and tag protection for `connector-v*`.

**Why public matters here:** GitHub environment protection rules (required reviewers, deployment
branch policies) are not available on private repositories outside paid plans. Every protected
workflow in this repository depends on them.

**Verify**

```bash
npm test
npm run security:repo
npm run check:docs
npm run test:workflow
gh repo view "$REPO" --json visibility,defaultBranchRef
```

---

## Stage 1 — Accounts and plans

Create these before touching GitHub. Each row says what the later stages actually consume from it.

| # | Account | Plan / tier | Why | Produces |
| --- | --- | --- | --- | --- |
| 1.1 | Cloudflare — **staging** | **Workers Paid** | Containers require the Workers Paid plan, and the private control plane runs as a Container. Workers Free cannot host this stack at all. | Account ID, API tokens, R2 access keys, R2 S3 endpoint, the deployed origin |
| 1.2 | Cloudflare — **production** | **Workers Paid** | Same reason. It must be a **separate account**, not a separate name inside the staging account. | Same set, production-scoped |
| 1.3 | Convex — staging deployment | Any plan that allows a deploy key | Durable control-plane state | `CONVEX_URL`, deploy key |
| 1.4 | Convex — production deployment | Same | Same | Same, production-scoped |
| 1.5 | Clerk — staging instance | Any | Platform user authentication; cloud mode disables dev tokens, so a real Clerk user is required from qualification level 2 onward | Secret key, publishable key, JWT issuer domain |
| 1.6 | Clerk — production instance | Any | Same | Same |
| 1.7 | npm — `@wearer-haitch` organisation | Any | Owning the scope and registering `@wearer-haitch/connector` before the first trusted-publisher release | Package ownership; **no token is ever added to GitHub** |
| 1.8 | GitHub | The repository itself | Environments, reviewers, protected dispatch | Four environments |
| 1.9 | A **T3 host for staging** | Your own machine | Qualification levels 2 and 3 need a live T3 Code with an authenticated provider, reachable only through its own connector | The enrolled connector, an environment id, a project id, a provider instance and model |

### Staging and production must be separate Cloudflare accounts

Account isolation is the real boundary; naming is not. The bootstrap procedure refuses known
production service, Queue, and derived bucket names, and every staging bucket name must match
`^[a-z0-9][a-z0-9-]{2,62}-staging$` and must not contain `production` — but those are guardrails
against a typo, not a security boundary. A token scoped to one account cannot touch the other; a
token scoped to one account with careful naming can. Use two accounts.

### Cloudflare API tokens

Create **three** tokens, each restricted to a single account:

| Token | Account | Used by | Needs to be able to |
| --- | --- | --- | --- |
| staging bootstrap token | staging | `staging-bootstrap` environment | Create Queues, create R2 buckets, deploy Workers and Containers, write Worker secrets, list Queues/buckets/deployments/versions/secret names |
| staging release token | staging | `staging` environment | Deploy Workers and Containers, read Queues/R2/deployments/versions/secret names (it never creates a resource) |
| production token | production | `production` environment | Deploy Workers and Containers, read Queues/R2/secret names |

Grant permission groups in the Cloudflare token screen that cover exactly the operations above; the
group names on that screen change over time, so match the operations rather than copying a name
from here. The scripts call Wrangler (`queues create`, `r2 bucket create`, `deploy`,
`secret bulk`, `secret list`, `deployments status`, `versions list`) and two read-only REST paths on
the account: `/queues` and `/r2/buckets`.

`CLOUDFLARE_ACCOUNT_ID` must be exactly 32 lowercase hexadecimal characters — the account ID as
Cloudflare prints it. Anything else fails with `cloudflare_account_invalid`.

**Decision — the staging origin.** `cloudflare/wrangler.jsonc` declares no `routes` and does not
disable `workers.dev` for the `staging` environment, so unless you attach a custom domain out of
band the deployed origin is the account's `workers.dev` URL for the Worker named
`agent-controller-cloud-staging`. You must know the exact final origin *before* bootstrap, because
it is both a variable and a Container secret and the two are compared for exact equality. Whatever
you choose, it must be HTTPS, must be an origin with no path and no trailing slash, and must not be
`localhost`. The completion plan records no default; the repository default behaviour is
`workers.dev`.

### R2

In the staging Cloudflare account, create an R2 API token and record its access key id, secret
access key, and the S3 API endpoint R2 shows for your account. Copy the endpoint exactly from the
dashboard rather than assembling it. Do **not** pre-create the buckets: bootstrap creates them and
refuses a bucket that already exists.

**Verify (Stage 1)**

```bash
# Cloudflare: the account id is 32 lowercase hex characters
printf '%s' "$CLOUDFLARE_STAGING_ACCOUNT_ID" | grep -Eq '^[0-9a-f]{32}$' && echo 'account id shape ok'
```

Confirm in each provider's own console that: the Cloudflare staging account shows the Workers Paid
plan; the Convex staging deployment exists and you can see its URL; the Clerk staging instance shows
both keys and its issuer domain; the `@wearer-haitch` npm scope is owned by you.

**Recovery (Stage 1).** Nothing is coupled yet. Delete the account, project, or token and start
again. If a token leaked, roll it in the provider console before continuing.

---

## Stage 2 — Generate the locally-generated secrets

Four values are generated on your machine, not by a provider. Generate them once, store them in
your password manager, and paste them into GitHub in Stage 4. Generate staging and production sets
separately; they must never be the same value.

Run these from a clean checkout of this repository with `npm ci` already done (the VAPID command
uses the repository's pinned `web-push` dependency).

### 2.1 T3 token encryption key (`T3_TOKEN_ENCRYPTION_KEY`)

`src/secretBox.mjs` derives an AES-256-GCM key by SHA-256 of whatever string you supply, so any
high-entropy string works. Use 48 random bytes:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
# or: openssl rand -base64 48 | tr -d '\n'; echo
```

### 2.2 Gateway Convex secret (`GATEWAY_CONVEX_SECRET`)

Same shape. This one value is entered **twice** — once as a Cloudflare Worker secret and once as a
Convex environment variable — and the two must be identical. Neither provider will show you the
stored value again, so your provisioning record is the only evidence they match.

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

### 2.3 Web Push VAPID key set (`WEB_PUSH_VAPID_KEYS`)

Managed staging and production use the **rotation-aware** form: a JSON array of at most three
records, each with `keyId`, `publicKey`, `privateKey`, `subject`, and exactly one entry with
`active: true` (see [notifications.md](notifications.md)). It is not a single key, and the
four single-key `WEB_PUSH_VAPID_*` variables are not used here.

```bash
node -e "
const { generateVAPIDKeys } = require('web-push');
const keys = generateVAPIDKeys();
console.log(JSON.stringify([{
  keyId: 'staging-REPLACE_WITH_YYYY-MM',
  publicKey: keys.publicKey,
  privateKey: keys.privateKey,
  subject: 'mailto:REPLACE_WITH_OPS_CONTACT@example.com',
  active: true,
}]));
" > vapid-staging.json
```

`subject` must be a `mailto:` or `https:` contact you control. Keep `vapid-staging.json` out of the
repository — write it to a scratch directory, upload it in Stage 4, then delete it. The server
validates the pair (public key must decode to a 65-byte uncompressed P-256 point, private key to 32
bytes) and refuses to send anything if the set is invalid.

When you later rotate, append the new record with `active: true`, set the old one to `active: false`,
and keep it until existing browser subscriptions have moved; each subscription records the key id it
used.

### 2.4 Web Push subscription sealing key (`WEB_PUSH_STORAGE_ENCRYPTION_KEY`)

A separate high-entropy string. It must be set explicitly: the Container's startup check fails when
it is absent even though the code would otherwise fall back to another key.

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

**Verify (Stage 2).** Check the VAPID set is one the server will accept, without sending anything:

```bash
WEB_PUSH_VAPID_KEYS="$(cat vapid-staging.json)" node -e "
import('./src/webPush.mjs').then((m) => {
  const config = m.loadWebPushConfig(process.env);
  console.log(config.supported === true ? 'vapid set accepted, active key: ' + config.activeKeyId
    : 'REJECTED: ' + config.reason);
});
"
```

**Recovery (Stage 2).** These values have no external state. If one leaks before deployment, throw
it away and generate another. After deployment, replacing `GATEWAY_CONVEX_SECRET` means changing it
in Cloudflare and Convex together, and replacing `T3_TOKEN_ENCRYPTION_KEY` invalidates every stored
T3 access token, which forces re-pairing.

---

## Stage 3 — Collect the provider values

Assemble this table before creating any GitHub environment. Every value has exactly one purpose.

| Value | Where it comes from | Notes |
| --- | --- | --- |
| Staging Cloudflare account ID | Cloudflare dashboard | 32 lowercase hex |
| Staging bootstrap API token | Stage 1 | Never production-scoped |
| Staging release API token | Stage 1 | Deploy plus reads only |
| Convex staging deploy key | Convex project settings | Names only the staging deployment |
| `CONVEX_URL` | Convex deployment URL | Must start with `https://` |
| Clerk staging secret key | Clerk dashboard | |
| Clerk staging publishable key | Clerk dashboard | Must match the same instance |
| Clerk JWT issuer domain | Clerk dashboard | Needed by Convex, see Stage 5 |
| R2 S3 endpoint | Cloudflare R2 dashboard | Must start with `https://` |
| R2 access key id / secret | Stage 1 | Staging-only |
| Media bucket name | Your choice | Must match `^[a-z0-9][a-z0-9-]{2,62}-staging$`, must not contain `production` |
| Firmware bucket name | Your choice | Same rule, and must differ from the media bucket |
| Staging origin | Your decision in Stage 1 | HTTPS origin, no path, no trailing slash, not `localhost` |
| The four Stage 2 secrets | Generated locally | |

Three equalities are checked by the bootstrap script and will fail the run if they are wrong:

- `STAGING_RUNTIME_PUBLIC_BASE_URL` must equal `NEXT_CODER_STAGING_URL` exactly;
- `STAGING_RUNTIME_S3_BUCKET` must equal `NEXT_CODER_STAGING_MEDIA_BUCKET` exactly;
- `STAGING_RUNTIME_FIRMWARE_S3_BUCKET` must equal `NEXT_CODER_STAGING_FIRMWARE_BUCKET` exactly.

---

## Stage 4 — GitHub environments, secrets, and variables

Four environments. They are not interchangeable, and the same underlying value appears under
**different names** in `staging-bootstrap` and `staging` — that is the single most common way to
burn a protected run, so the tables below name the environment for every secret.

### 4.0 Protection settings (all four)

| Setting | staging-bootstrap | staging | npm-release | production |
| --- | --- | --- | --- | --- |
| Required reviewers | you | you | you | a second person, not you |
| Prevent self-review | **off** | **off** | **off** | on |
| Deployment branches | default branch only | default branch only | default branch only | default branch only |
| Administrators can bypass | off | off | off | off |
| Environment secrets | see 4.1 | see 4.2 | none | see 4.4 |

**Decision — who reviews.** Two facts about GitHub environments decide this, and an earlier revision
of this runbook had both wrong.

**Self-review is allowed unless you switch it off.** "Prevent self-review" is optional and defaults
to off. With it off, you can be the sole required reviewer and approve your own dispatch. The gate
still does its real job: the run halts, tells you what it is about to mutate, and waits for a
deliberate click. What it cannot do is make a second person look. A solo maintainer is therefore
**not** blocked from running any protected workflow.

**Listing two reviewers does not require two approvals.** GitHub proceeds when *one* of the listed
reviewers approves. Two-person control cannot be built by adding names to the list; the only way to
guarantee someone other than the dispatcher approves is to switch prevent-self-review **on** and
list only people who are not the dispatcher.

The settings above follow from that. Staging and npm-release are solo-operable now, because staging
is isolated and disposable and the npm package is yours. Production keeps prevent-self-review on and
must list someone who is not you, so the one irreversible boundary in this system keeps a genuine
second pair of eyes. Until that person exists, Phases 1 through 6 of the completion plan run solo
and only production promotion waits.

Create an environment (repeat for each of the four names):

```bash
REPO="Wearer-Lab/next-coder"
ME_ID="$(gh api user --jq .id)"

# Staging and npm-release: you are the reviewer, and you may approve your own dispatch.
for ENVIRONMENT in staging-bootstrap staging npm-release; do
  gh api --method PUT "repos/$REPO/environments/$ENVIRONMENT" --input - <<JSON
{
  "wait_timer": 0,
  "prevent_self_review": false,
  "can_admins_bypass": false,
  "reviewers": [{ "type": "User", "id": $ME_ID }],
  "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": false }
}
JSON
done
```

Production is deliberately different, and is the one environment you cannot create alone. Its
reviewer must be someone other than you, because with prevent-self-review on your own approval is
refused and the run would sit in the queue forever:

```bash
REVIEWER_ID="$(gh api users/REPLACE_WITH_SECOND_REVIEWER_LOGIN --jq .id)"

gh api --method PUT "repos/$REPO/environments/production" --input - <<JSON
{
  "wait_timer": 0,
  "prevent_self_review": true,
  "can_admins_bypass": false,
  "reviewers": [{ "type": "User", "id": $REVIEWER_ID }],
  "deployment_branch_policy": { "protected_branches": true, "custom_branch_policies": false }
}
JSON
```

Add further production reviewers by repeating that call with more entries in the `reviewers` array;
remember that any one of them approving is enough. If your GitHub API version rejects `can_admins_bypass`, remove that field and
untick **Allow administrators to bypass configured protection rules** in the environment settings UI
instead — do not leave it on.

**Already done on 2026-09-09.** `staging-bootstrap`, `staging` and `npm-release` exist on
`Wearer-Lab/next-coder` with the settings above: one required reviewer (the repository owner),
prevent-self-review off, default-branch-only deployments, and no administrator bypass. Verify with
`gh api repos/Wearer-Lab/next-coder/environments --jq '.environments[].name'`. Their **secrets
are not set**, which is the remaining work in 4.1 through 4.3. `production` is deliberately absent
until a second reviewer exists.

### 4.1 Environment `staging-bootstrap`

Consumed by `.github/workflows/staging-bootstrap.yml`, job `bootstrap`.

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_BOOTSTRAP_API_TOKEN` | Staging bootstrap token |
| `CLOUDFLARE_STAGING_ACCOUNT_ID` | Staging account ID |
| `CONVEX_STAGING_DEPLOY_KEY` | Staging Convex deploy key |
| `STAGING_RUNTIME_PUBLIC_BASE_URL` | The staging origin (equal to `NEXT_CODER_STAGING_URL`) |
| `STAGING_RUNTIME_CONVEX_URL` | Convex deployment URL |
| `STAGING_RUNTIME_GATEWAY_CONVEX_SECRET` | Stage 2.2 value |
| `STAGING_RUNTIME_CLERK_SECRET_KEY` | Clerk staging secret key |
| `STAGING_RUNTIME_CLERK_PUBLISHABLE_KEY` | Clerk staging publishable key |
| `STAGING_RUNTIME_T3_TOKEN_ENCRYPTION_KEY` | Stage 2.1 value |
| `STAGING_RUNTIME_S3_ENDPOINT` | R2 S3 endpoint |
| `STAGING_RUNTIME_S3_BUCKET` | Media bucket name |
| `STAGING_RUNTIME_FIRMWARE_S3_BUCKET` | Firmware bucket name |
| `STAGING_RUNTIME_S3_ACCESS_KEY_ID` | R2 access key id |
| `STAGING_RUNTIME_S3_SECRET_ACCESS_KEY` | R2 secret access key |
| `STAGING_RUNTIME_WEB_PUSH_VAPID_KEYS` | Stage 2.3 JSON array |
| `STAGING_RUNTIME_WEB_PUSH_STORAGE_ENCRYPTION_KEY` | Stage 2.4 value |

Each `STAGING_RUNTIME_<NAME>` secret becomes the Container Worker secret `<NAME>`. The thirteen
runtime names are exactly `PUBLIC_BASE_URL`, `CONVEX_URL`, `GATEWAY_CONVEX_SECRET`,
`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `T3_TOKEN_ENCRYPTION_KEY`, `S3_ENDPOINT`, `S3_BUCKET`,
`FIRMWARE_S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `WEB_PUSH_VAPID_KEYS`, and
`WEB_PUSH_STORAGE_ENCRYPTION_KEY`.

```bash
E=staging-bootstrap
gh secret set CLOUDFLARE_BOOTSTRAP_API_TOKEN               --repo "$REPO" --env "$E" --body 'REPLACE_WITH_STAGING_BOOTSTRAP_TOKEN'
gh secret set CLOUDFLARE_STAGING_ACCOUNT_ID                --repo "$REPO" --env "$E" --body 'REPLACE_WITH_32_HEX_ACCOUNT_ID'
gh secret set CONVEX_STAGING_DEPLOY_KEY                    --repo "$REPO" --env "$E" --body 'REPLACE_WITH_CONVEX_STAGING_DEPLOY_KEY'
gh secret set STAGING_RUNTIME_PUBLIC_BASE_URL              --repo "$REPO" --env "$E" --body 'https://REPLACE_WITH_STAGING_ORIGIN'
gh secret set STAGING_RUNTIME_CONVEX_URL                   --repo "$REPO" --env "$E" --body 'https://REPLACE_WITH_CONVEX_DEPLOYMENT.convex.cloud'
gh secret set STAGING_RUNTIME_GATEWAY_CONVEX_SECRET        --repo "$REPO" --env "$E" --body 'REPLACE_WITH_STAGE_2_2_VALUE'
gh secret set STAGING_RUNTIME_CLERK_SECRET_KEY             --repo "$REPO" --env "$E" --body 'REPLACE_WITH_CLERK_STAGING_SECRET_KEY'
gh secret set STAGING_RUNTIME_CLERK_PUBLISHABLE_KEY        --repo "$REPO" --env "$E" --body 'REPLACE_WITH_CLERK_STAGING_PUBLISHABLE_KEY'
gh secret set STAGING_RUNTIME_T3_TOKEN_ENCRYPTION_KEY      --repo "$REPO" --env "$E" --body 'REPLACE_WITH_STAGE_2_1_VALUE'
gh secret set STAGING_RUNTIME_S3_ENDPOINT                  --repo "$REPO" --env "$E" --body 'https://REPLACE_WITH_R2_S3_ENDPOINT'
gh secret set STAGING_RUNTIME_S3_BUCKET                    --repo "$REPO" --env "$E" --body 'REPLACE_WITH_MEDIA_BUCKET-staging'
gh secret set STAGING_RUNTIME_FIRMWARE_S3_BUCKET           --repo "$REPO" --env "$E" --body 'REPLACE_WITH_FIRMWARE_BUCKET-staging'
gh secret set STAGING_RUNTIME_S3_ACCESS_KEY_ID             --repo "$REPO" --env "$E" --body 'REPLACE_WITH_R2_ACCESS_KEY_ID'
gh secret set STAGING_RUNTIME_S3_SECRET_ACCESS_KEY         --repo "$REPO" --env "$E" --body 'REPLACE_WITH_R2_SECRET_ACCESS_KEY'
gh secret set STAGING_RUNTIME_WEB_PUSH_STORAGE_ENCRYPTION_KEY --repo "$REPO" --env "$E" --body 'REPLACE_WITH_STAGE_2_4_VALUE'

# read the multi-line JSON from the file instead of the command line
gh secret set STAGING_RUNTIME_WEB_PUSH_VAPID_KEYS --repo "$REPO" --env "$E" < vapid-staging.json
rm -f vapid-staging.json
```

### 4.2 Environment `staging`

Consumed by `.github/workflows/staging-release.yml`, job `release`. **Same values as three of the
bootstrap secrets, under different names.** No runtime secrets: the release workflow only reads
Worker secret *names* from Cloudflare, never values.

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Staging release token (deploy plus reads) |
| `CLOUDFLARE_ACCOUNT_ID` | Same staging account ID as `CLOUDFLARE_STAGING_ACCOUNT_ID` |
| `CONVEX_DEPLOY_KEY` | Same key as `CONVEX_STAGING_DEPLOY_KEY` |

```bash
E=staging
gh secret set CLOUDFLARE_API_TOKEN  --repo "$REPO" --env "$E" --body 'REPLACE_WITH_STAGING_RELEASE_TOKEN'
gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO" --env "$E" --body 'REPLACE_WITH_32_HEX_ACCOUNT_ID'
gh secret set CONVEX_DEPLOY_KEY     --repo "$REPO" --env "$E" --body 'REPLACE_WITH_CONVEX_STAGING_DEPLOY_KEY'
```

### 4.3 Environment `npm-release`

No secrets and no variables. Publication uses npm trusted publishing over OIDC, and the workflow
never reads an npm token. In npm package settings, configure a GitHub Actions trusted publisher for
this repository, workflow filename `npm-connector-release.yml`, environment `npm-release`, and the
publish action. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` anywhere. After trusted publishing works,
disable token publishing for the package and revoke old automation tokens.

The actual publication is completion plan Phase 3 and is out of scope here; only the environment is
created now, because it belongs with the rest of the environment configuration.

### 4.4 Environment `production`

Consumed by `.github/workflows/production-promotion.yml` (four jobs, same environment, approved
separately). Nothing here is used by Phase 2, but configure it now while you have the values.

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_PRODUCTION_API_TOKEN` | Production account token |
| `CLOUDFLARE_PRODUCTION_ACCOUNT_ID` | Production account ID |
| `CONVEX_PRODUCTION_DEPLOY_KEY` | Production Convex deploy key |

```bash
E=production
gh secret set CLOUDFLARE_PRODUCTION_API_TOKEN  --repo "$REPO" --env "$E" --body 'REPLACE_WITH_PRODUCTION_TOKEN'
gh secret set CLOUDFLARE_PRODUCTION_ACCOUNT_ID --repo "$REPO" --env "$E" --body 'REPLACE_WITH_PRODUCTION_32_HEX_ACCOUNT_ID'
gh secret set CONVEX_PRODUCTION_DEPLOY_KEY     --repo "$REPO" --env "$E" --body 'REPLACE_WITH_CONVEX_PRODUCTION_DEPLOY_KEY'
```

### 4.5 Variables — set these at the repository level

Six non-secret variables. Set them as **repository** variables rather than environment variables:
the production promotion workflow's first job (`verify-evidence`) reads four of them and runs
*without* entering any environment, so environment-only definitions make that job fail with
`staging_url_invalid` before a reviewer ever sees it. Repository variables are visible to the
environment jobs as well, and an environment-level definition still overrides one if you later want
that.

| Variable | Value | Read by |
| --- | --- | --- |
| `NEXT_CODER_STAGING_URL` | Staging origin | bootstrap, release, promotion |
| `NEXT_CODER_STAGING_MEDIA_BUCKET` | Media bucket name | bootstrap, release |
| `NEXT_CODER_STAGING_FIRMWARE_BUCKET` | Firmware bucket name | bootstrap, release |
| `NEXT_CODER_PRODUCTION_URL` | Production origin | promotion |
| `NEXT_CODER_PRODUCTION_MEDIA_BUCKET` | Production media bucket name | promotion |
| `NEXT_CODER_PRODUCTION_FIRMWARE_BUCKET` | Production firmware bucket name | promotion |

```bash
gh variable set NEXT_CODER_STAGING_URL                    --repo "$REPO" --body 'https://REPLACE_WITH_STAGING_ORIGIN'
gh variable set NEXT_CODER_STAGING_MEDIA_BUCKET           --repo "$REPO" --body 'REPLACE_WITH_MEDIA_BUCKET-staging'
gh variable set NEXT_CODER_STAGING_FIRMWARE_BUCKET        --repo "$REPO" --body 'REPLACE_WITH_FIRMWARE_BUCKET-staging'
gh variable set NEXT_CODER_PRODUCTION_URL                   --repo "$REPO" --body 'https://REPLACE_WITH_PRODUCTION_ORIGIN'
gh variable set NEXT_CODER_PRODUCTION_MEDIA_BUCKET          --repo "$REPO" --body 'REPLACE_WITH_MEDIA_BUCKET-production'
gh variable set NEXT_CODER_PRODUCTION_FIRMWARE_BUCKET       --repo "$REPO" --body 'REPLACE_WITH_FIRMWARE_BUCKET-production'
```

**Verify (Stage 4)**

```bash
gh api "repos/$REPO/environments" --jq '.environments[].name'
for E in staging-bootstrap staging npm-release production; do
  echo "== $E"
  gh api "repos/$REPO/environments/$E" \
    --jq '{protected_branches: .deployment_branch_policy.protected_branches, can_admins_bypass, rules: [.protection_rules[].type]}'
  gh secret list --repo "$REPO" --env "$E"
done
gh variable list --repo "$REPO"
```

Check the counts against the tables: 16 secrets in `staging-bootstrap`, 3 in `staging`, 0 in
`npm-release`, 3 in `production`, and 6 repository variables. `gh` never shows a secret value, so
compare names only — the values are checked for the first time by the bootstrap run itself.

**Recovery (Stage 4).** Secrets and variables are overwritten by setting them again. A secret set to
a wrong value is invisible until a run fails; when a bootstrap run fails on a credential, assume the
value is wrong, re-set it, and use `resume` (Stage 6) rather than a fresh bootstrap.

---

## Stage 5 — Convex pre-step (do not skip)

The bootstrap workflow sets exactly one Convex environment variable: `GATEWAY_CONVEX_SECRET`. But
`convex/auth.config.ts` reads `process.env.CLERK_JWT_ISSUER_DOMAIN`, which Convex evaluates when
functions are pushed. If that variable is missing, the bootstrap's `deploy-convex` action fails
partway through an otherwise-successful bootstrap.

Set it yourself, once, against the staging deployment, before dispatching bootstrap:

```bash
CONVEX_DEPLOY_KEY='REPLACE_WITH_CONVEX_STAGING_DEPLOY_KEY' \
  npx convex env set CLERK_JWT_ISSUER_DOMAIN 'https://REPLACE_WITH_CLERK_ISSUER.clerk.accounts.dev'
```

Use the issuer domain your Clerk staging instance actually shows. Do not set
`GATEWAY_CONVEX_SECRET` by hand — the bootstrap provisions it over standard input, and a value you
type here that differs from the GitHub secret produces a stack that authenticates nothing.

**Verify (Stage 5)**

```bash
CONVEX_DEPLOY_KEY='REPLACE_WITH_CONVEX_STAGING_DEPLOY_KEY' npx convex env list --names-only
# expect CLERK_JWT_ISSUER_DOMAIN, and no GATEWAY_CONVEX_SECRET yet
```

**Recovery (Stage 5).** `npx convex env set` is idempotent; run it again with the corrected value.

---

## Stage 6 — Dispatch staging bootstrap (completion plan 2.1)

Full detail: [staging-bootstrap.md](staging-bootstrap.md).

### 6.1 Choose the inputs

| Input | Rule |
| --- | --- |
| `operation` | `bootstrap` for a fresh empty account |
| `target_commit_sha` | Exact 40-character lowercase commit, already on the default branch |
| `bootstrap_id` | Your stable operator ticket, 8 to 64 characters, `^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$`. Record it outside logs and artifacts — `resume` and `abort_cleanup` need the same value |
| `current_edge_version` | Empty for a fresh bootstrap |
| `current_control_plane_version` | Empty for a fresh bootstrap |
| `confirmation` | `bootstrap:staging:<target_commit_sha>:<bootstrap_id>` — byte-exact, no spaces |

### 6.2 Dispatch

```bash
TARGET_SHA='REPLACE_WITH_40_CHARACTER_COMMIT_SHA'
BOOTSTRAP_ID='stg-bootstrap-001'

gh workflow run staging-bootstrap.yml --repo "$REPO" --ref "$BRANCH" \
  -f operation=bootstrap \
  -f target_commit_sha="$TARGET_SHA" \
  -f bootstrap_id="$BOOTSTRAP_ID" \
  -f current_edge_version= \
  -f current_control_plane_version= \
  -f confirmation="bootstrap:staging:${TARGET_SHA}:${BOOTSTRAP_ID}"
```

The first job runs credential-free and proves the checkout, branch, confirmation, topology, and the
repository gates. The second job waits for your reviewer, then performs the whole ordered mutation:
three Queues, two R2 buckets, the fail-closed edge stub, the private control plane with the Container
rollout disabled, the Worker secrets, the Convex secret and deploy, the final private Worker with an
immediate Container rollout, the final edge Worker and Static Assets, and finally the credential-free
boundary qualification.

### 6.3 Verify

```bash
gh run list --repo "$REPO" --workflow staging-bootstrap.yml --limit 1
RUN_ID='REPLACE_WITH_RUN_ID'
gh run download "$RUN_ID" --repo "$REPO" -n "staging-bootstrap-bootstrap-${TARGET_SHA}" -D ./evidence
jq '{schema, result, phases: [.phases[].name]}' ./evidence/staging-bootstrap-evidence.json
```

The artifact schema is `next-coder.staging-bootstrap.v1` and its `result` must be `passed`.
Then confirm the origin answers, and record the two Worker version IDs you will need in Stage 7:

```bash
curl -fsS 'https://REPLACE_WITH_STAGING_ORIGIN/health' | jq '.'
```

Every binding must report ready. **The evidence artifact deliberately excludes raw Worker version
IDs** (it stores hashed references), so read the two active 100%-traffic version IDs from the
Cloudflare dashboard — Workers → `agent-controller-cloud-staging` and
`agent-controller-control-plane-staging` → Deployments — or with a read-scoped token locally:

```bash
npm --prefix cloudflare exec wrangler -- deployments status --env staging --json
npm --prefix cloudflare-control-plane exec wrangler -- deployments status --env staging --json
```

Record both, plus the deployed source commit. Stage 7 cannot be dispatched without them.

### 6.4 Recovery

There is no automatic rollback. Preserve the evidence artifact, look at the provider state, then:

- **Something failed after resources existed** — dispatch `resume` with the *same*
  `target_commit_sha` and `bootstrap_id`, plus the exact currently active edge and control-plane
  version IDs. Confirmation: `resume:staging:<target_commit_sha>:<bootstrap_id>`. Resume skips
  completed stages and fails closed if an active version changed, an annotation differs, or provider
  inventory is ambiguous.
- **Only the fail-closed edge stub exists and no private control-plane Worker was ever created** —
  dispatch `abort_cleanup` with the stub's exact active edge version and the same commit and
  bootstrap ID. Confirmation: `abort_cleanup:staging:<target_commit_sha>:<bootstrap_id>`. It deletes
  only the owned stub and the three named Queues and two named buckets it finds.
- **The private control plane already exists and you want to start over** — that is outside this
  workflow. Durable Object, Convex, and Container state may already be durable, so it needs a
  separately reviewed incident plan.

Never start a new `bootstrap_id` over a partial stack.

---

## Stage 7 — Two staging releases: deploy, then rollback (completion plan 2.2)

Full detail: [staging-release.md](staging-release.md).

### 7.1 The sequence that actually works

The release workflow refuses `target_commit_sha == current_commit_sha`. So you cannot "release the
commit you just bootstrapped". The two evidence artifacts the completion plan wants — one `deploy`
and one `rollback` — come from this sequence:

1. Bootstrap deployed commit **A** (Stage 6).
2. Land a **trivial follow-on commit B** on the default branch and dispatch `deploy` with
   `target=B`, `current=A`.
3. Dispatch `rollback` with `target=A`, `current=B`.

Rollback is rejected when the two commits differ in the whole `convex/` tree, in either Durable
Object migration history, or in staging Durable Object / Service Binding / Queue / Cron / Container
topology. So commit **B** must not touch `convex/` or either `wrangler.jsonc` topology — a
documentation or console-only change is the right shape.

### 7.2 Before dispatch

Record, without copying tokens or resource identifiers into the ticket: both commits, both active
100%-traffic Worker version IDs (Stage 6.3), the passing `Hermetic CI` run for the candidate, the
reviewed Convex dry-run, and a current Convex backup if the release changes durable schema or data
interpretation.

### 7.3 Dispatch the forward deploy

```bash
CURRENT_SHA="$TARGET_SHA"                       # commit A, currently deployed
TARGET_SHA_B='REPLACE_WITH_40_CHARACTER_COMMIT_B'
EDGE_VERSION='REPLACE_WITH_ACTIVE_EDGE_VERSION_ID'
CONTROL_VERSION='REPLACE_WITH_ACTIVE_CONTROL_PLANE_VERSION_ID'

gh workflow run staging-release.yml --repo "$REPO" --ref "$BRANCH" \
  -f operation=deploy \
  -f target_commit_sha="$TARGET_SHA_B" \
  -f current_commit_sha="$CURRENT_SHA" \
  -f current_edge_version="$EDGE_VERSION" \
  -f current_control_plane_version="$CONTROL_VERSION" \
  -f confirmation="deploy:staging:${TARGET_SHA_B}"
```

The confirmation for this workflow has **three** parts, not four: `deploy:staging:<target>`. There is
no bootstrap ID in it.

### 7.4 Verify

```bash
gh run download REPLACE_WITH_RUN_ID --repo "$REPO" \
  -n "staging-release-deploy-${TARGET_SHA_B}" -D ./evidence
jq '{schema, result}' ./evidence/staging-release-evidence.json
curl -fsS 'https://REPLACE_WITH_STAGING_ORIGIN/health' | jq '.'
```

Schema `next-coder.staging-release.v1`, `result` passed. Re-read both active version IDs from
Cloudflare; they changed, and the rollback dispatch needs the new ones.

### 7.5 Dispatch the rollback

```bash
gh workflow run staging-release.yml --repo "$REPO" --ref "$BRANCH" \
  -f operation=rollback \
  -f target_commit_sha="$CURRENT_SHA" \
  -f current_commit_sha="$TARGET_SHA_B" \
  -f current_edge_version='REPLACE_WITH_NEW_ACTIVE_EDGE_VERSION_ID' \
  -f current_control_plane_version='REPLACE_WITH_NEW_ACTIVE_CONTROL_PLANE_VERSION_ID' \
  -f confirmation="rollback:staging:${CURRENT_SHA}"
```

Keep both artifacts: `staging-release-deploy-<B>` and `staging-release-rollback-<A>`.

### 7.6 Recovery

No automatic rollback runs after a failed release, on purpose — an automatic reversal could cross a
Durable Object or Convex compatibility boundary without anyone seeing which mutation completed. Read
the redacted artifact for the last observed component versions, decide explicitly, and dispatch
`rollback` to a compatible older ancestor. If the compatibility rule rejects it, you need an
incident-specific plan: Convex data restore, environment-variable restore, and code restore are three
separate operations, and Cloudflare may refuse old Worker versions after a Durable Object change.

---

## Stage 8 — Qualification levels 1 to 3 (completion plan 2.3 to 2.5)

Full detail: [staging-qualification.md](staging-qualification.md). All three run from your machine
against the deployed origin. Each mode refuses to start until the weaker ones pass.

### 8.1 Level 1 — credential-free cloud boundary (2.3)

```bash
npm run qualify:staging -- --base-url 'https://REPLACE_WITH_STAGING_ORIGIN' \
  > staging-boundary-evidence.json
```

Proves `/health` reports the private control-plane binding, connector event sink, background Queue,
quarantine Queue and Queue-owned scheduling as ready; that public `/v1/auth/config` traverses the
Service Binding and Container, reports cloud mode, and confirms development-token issuance is off;
and that the three `/v1/internal/*` capabilities plus the local connector-router bridge and
development ticket issuer return exactly `404`. A `401`, `403`, redirect, or success where a `404`
is required is a failure, not a partial pass.

**Verify:** the command exits zero and the JSON carries schema
`next-coder.staging-qualification.v1`. Keep the file with the release record.

### 8.2 Level 2 — authenticated connector-first readiness (2.4)

First, get the staging stack a live T3 environment:

1. Sign in to the deployed console as a real Clerk staging user.
2. Follow onboarding to mint a single-use connector enrollment code
   (`POST /v1/t3/connect-sessions` is what the console calls).
3. On the Phase 1.9 T3 host, run the connector against staging. The package is not published until
   completion plan Phase 3, so at this point run it from a checkout on that host:

   ```bash
   node packages/connector/bin/next-coder-connect.mjs connect \
     --server 'https://REPLACE_WITH_STAGING_ORIGIN' \
     --code 'REPLACE_WITH_ONE_TIME_ENROLLMENT_CODE' \
     --install-service
   ```

   This is checkout evidence, not the install-free `npx` journey; that proof belongs to Phase 3.
4. Read the environment id and project id from the console, or from `GET /v1/t3/environments` with
   the same session token, and note the provider instance and model the environment actually offers.

Then run level 2. The token goes in an environment variable or a mode-`0600` file — there is no
command-line token option:

```bash
export NEXT_CODER_STAGING_ACCESS_TOKEN='REPLACE_WITH_SHORT_LIVED_PLATFORM_SESSION_TOKEN'
npm run qualify:staging -- \
  --base-url 'https://REPLACE_WITH_STAGING_ORIGIN' \
  --environment-id 'REPLACE_WITH_ENVIRONMENT_ID' \
  --project-id 'REPLACE_WITH_PROJECT_ID' \
  --provider-instance 'REPLACE_WITH_PROVIDER_INSTANCE' \
  --model 'REPLACE_WITH_MODEL' \
  > staging-readiness-evidence.json
unset NEXT_CODER_STAGING_ACCESS_TOKEN
```

In cloud mode there is no platform API token to mint — `POST /v1/users/dev` is disabled, and level 1
proves it. The token is a Clerk session token for the signed-in staging user; the console obtains
one with `session.getToken()`. Clerk session tokens are short-lived, so mint one immediately before
the run, and if a run fails with an authentication error partway through, mint a fresh one and run
again.

**Verify:** all five layers green — dev tokens disabled, environment connector-backed, connector
online on protocol v1 with fresh presence and fresh `ready` T3 health, a fresh snapshot traversing
cloud → connector → local T3, and the named project with a currently usable provider and model.

### 8.3 Level 3 — completed first command (2.5)

This mode is **mutating**: it creates one new thread in the named project and sends one prompt. Use
an isolated test project.

```bash
export NEXT_CODER_STAGING_ACCESS_TOKEN='REPLACE_WITH_FRESH_SESSION_TOKEN'
export NEXT_CODER_STAGING_PROMPT='Staging qualification: reply with a short readiness confirmation.'
npm run qualify:staging -- \
  --base-url 'https://REPLACE_WITH_STAGING_ORIGIN' \
  --environment-id 'REPLACE_WITH_ENVIRONMENT_ID' \
  --project-id 'REPLACE_WITH_PROJECT_ID' \
  --provider-instance 'REPLACE_WITH_PROVIDER_INSTANCE' \
  --model 'REPLACE_WITH_MODEL' \
  --exercise-first-command \
  > staging-first-command-evidence.json
unset NEXT_CODER_STAGING_ACCESS_TOKEN NEXT_CODER_STAGING_PROMPT
```

**Verify:** the launch response is `dispatched` and the authenticated command ledger reaches
`completed` on the same command, retaining the exact environment, thread, project, provider, model
and `thread.launch` contract. An acknowledgement alone is not a pass, and the bounded three-minute
timeout is a failure.

**Recovery (Stage 8).** Levels 1 and 2 mutate nothing; rerun them. Level 3 leaves a real thread
behind on purpose — the command never archives or deletes it, because cleanup is a separate
potentially destructive decision. Archive it from the console if you want the project clean. If
level 3 fails, the created thread may still exist; check before running again so you do not
accumulate threads.

---

## What Phase 2 has and has not proven

A green Stage 6 to 8 proves: the named bootstrap orchestration completed, one routine deploy and one
compatible rollback completed, the credential-free public/private boundary holds, a connector-backed
environment is readable end to end, and one command completed with a live provider reply.

It does not prove hosted Queue retry or DLQ behaviour, R2 or Convex durability, Analytics Engine
ingestion or dashboards, WebSocket streaming, approval or structured-input flows, sleep and WAN
recovery, load, cost, browser GPU behaviour, or physical controller TLS. Those are completion plan
Phases 4 to 6, and none of them may be inferred from a passing resource-name check.

---

## Appendix A — exact formats

| Thing | Rule |
| --- | --- |
| Commit SHA inputs | 40 lowercase hexadecimal characters |
| Worker version inputs | `^[0-9a-f-]{16,64}$` |
| `bootstrap_id` | `^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$` |
| Cloudflare account ID | `^[0-9a-f]{32}$` |
| Staging bucket names | `^[a-z0-9][a-z0-9-]{2,62}-staging$`, must not contain `production`, and the two must differ |
| Staging origin | HTTPS, exact origin (no path, no trailing slash), not `localhost` |
| Bootstrap confirmation | `bootstrap\|resume\|abort_cleanup` + `:staging:` + target SHA + `:` + bootstrap id |
| Release confirmation | `deploy\|rollback` + `:staging:` + target SHA |
| npm release confirmation | `publish:@wearer-haitch/connector@X.Y.Z:connector-vX.Y.Z:<commit>` |
| Production confirmation | `promote:production:<target-commit>:<manifest-sha256>` |
| Convex environment variables | `GATEWAY_CONVEX_SECRET` (set by bootstrap) and `CLERK_JWT_ISSUER_DOMAIN` (set by you, Stage 5) |

## Appendix B — decisions this sequence needs

| Decision | Default | Needed by |
| --- | --- | --- |
| License ratification | Apache-2.0, already in place | Stage 0 |
| Staging origin: `workers.dev` or a custom domain | The repository config attaches no route, so `workers.dev` is what a deploy produces | Stage 1 |
| Second reviewer identity (production only; staging and npm-release are solo-operable) | None recorded — needed before Phase 7, not before Phase 2 | Stage 4 |
| npm package name and scope | `@wearer-haitch/connector` as committed | Stage 4.3 |
| Which commit is the trivial follow-on **B** for the rollback proof | None recorded; it must not touch `convex/` or Worker topology | Stage 7 |
| Where Parakeet inference runs | Operator-run sidecar next to the Container | Phase 4, not this document |
| Container sizing: singleton versus partitioning | Singleton with the provisional 16-environment budget | Phase 4, not this document |
| Hardware scope for the beta | Hosyond only | Phase 6, not this document |

## Appendix C — known runbook versus workflow disagreements

Recorded while cross-checking every name in this document against the workflow that reads it. The
workflow is authoritative in all five cases, and this document already follows it.

1. **Production variables cannot be environment-only.** `production-promotion.md` says to configure
   `NEXT_CODER_STAGING_URL`, `NEXT_CODER_PRODUCTION_URL`,
   `NEXT_CODER_PRODUCTION_MEDIA_BUCKET` and `NEXT_CODER_PRODUCTION_FIRMWARE_BUCKET` as
   `production` environment variables. The workflow's first job, `verify-evidence`, reads all four
   and has no `environment:` block, and `normalizePromotionInput` requires all four to be non-empty
   and the two URLs to be HTTPS. Environment-only definitions fail that job before any reviewer is
   asked. Stage 4.5 therefore sets them at repository level.
2. **Convex needs `CLERK_JWT_ISSUER_DOMAIN` and nothing provisions it.** `staging-bootstrap.md`
   describes the Convex step as "provision the matching Convex gateway secret … then deploy Convex",
   and the script only ever sets `GATEWAY_CONVEX_SECRET`. But `convex/auth.config.ts` reads
   `process.env.CLERK_JWT_ISSUER_DOMAIN`, which is evaluated on push. Stage 5 adds the missing
   manual step.
3. **The completion plan's 2.2 wording cannot be dispatched literally.** It says to dispatch staging
   release "for the same commit". `normalizeReleaseInput` rejects
   `target_commit_sha == current_commit_sha` with `target_must_differ_from_current`. Stage 7 gives
   the sequence that does produce one `deploy` and one `rollback` artifact.
4. **The same three values live under six different names.** `staging-bootstrap` uses
   `CLOUDFLARE_BOOTSTRAP_API_TOKEN` / `CLOUDFLARE_STAGING_ACCOUNT_ID` / `CONVEX_STAGING_DEPLOY_KEY`;
   `staging` uses `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CONVEX_DEPLOY_KEY`. Both
   runbooks are individually correct and neither mentions the other. The account ID and the Convex
   deploy key are the same value twice; only the Cloudflare tokens legitimately differ, because
   bootstrap needs create authority and release does not.
5. **`npm-connector-release.md`'s one-time setup steps 1 and 2 are already done.** They say the
   maintainer must still choose a license, replace `"license": "UNLICENSED"`, add `LICENSE` to the
   `files` allowlist, and supply repository metadata that "the current manifest has no authoritative
   repository URL" for. `packages/connector/package.json` now carries `"license": "Apache-2.0"`,
   `LICENSE` in `files`, both `LICENSE` files exist, and `repository.url` names the public
   repository with `directory: packages/connector`. Only steps 3 to 5 — the trusted publisher, the
   `npm-release` environment, and disabling token publishing — remain.

Two smaller notes, neither a contradiction:

- `auth-storage.md` tells you to run `npx convex env set T3_TOKEN_ENCRYPTION_KEY …`. No Convex
  function reads it — `convex/` reads only `GATEWAY_CONVEX_SECRET` and `CLERK_JWT_ISSUER_DOMAIN` —
  because in managed cloud mode the Container does the encrypting. That instruction belongs to the
  self-hosted deployment shape.
- The bootstrap evidence artifact excludes raw Worker version IDs by design, and the staging release
  workflow requires them as inputs. They must be read from Cloudflare between Stage 6 and Stage 7;
  neither runbook says where the operator gets them.
