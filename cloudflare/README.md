# Next Coder Cloudflare runtime

This package is the Cloudflare-native edge runtime for Next Coder. It serves the built React
console, consumes short-lived connector WebSocket tickets, routes connector traffic through one
Durable Object per T3 environment, and delegates the existing Node control plane to the private
Worker/Container package in `../cloudflare-control-plane`. The Node gateway is intentionally not
bundled into this Worker, and neither package has been deployed.

## Implemented boundary

```text
browser/controller
       │
       ▼
Worker + Static Assets
       │
       ├── non-socket /v1 + atomic ticket consumption ── CONTROL_PLANE Service Binding
       │                                                   │
       │                                                   ▼
       │                                          private Worker + Container
       │                                                   │
       │                                                   ├── Convex + S3-compatible R2
       │                                                   └── private background capability
       │
       └── environment id ── EnvironmentConnectorHub Durable Object
                                  │
                                  └── hibernatable WebSocket ── local connector ── T3

Container ── connector-router.internal ── private RPC binding
          ── ControlPlaneConnectorRouterEntrypoint ── hub

Queue/Cron ── private Container capability ── media/reconciliation/retention/projector work
```

The public socket route consumes the short-lived ticket before selecting the environment Durable
Object. The raw ticket is not forwarded in the Durable Object URL. Local development uses
`DevelopmentConnectorTicketStore`, a separate Durable Object that atomically consumes a SHA-256
ticket key. Staging and production use one required `CONTROL_PLANE` Service Binding for both the
same-origin `/v1` API and atomic ticket consumption. The consumer response matches the backend Store
shape: `{ connector, ticket, reason }`. The public socket URL is intercepted at the edge; its raw
ticket is sent only in the private consumption request body and is never forwarded in an internal
URL.

`EnvironmentConnectorHub` provides:

- WebSocket hibernation with a small serialized attachment;
- `hello`, `welcome`, heartbeat, accepted/completed/failed response, event, and snapshot frames;
- a single active connector per environment with an explicit supersession close;
- 1 MiB frames, 32 pending requests, bounded deadlines, 24-hour/1,000-entry idempotency receipts,
  and terminal-result retention bounded by both 1,000 entries and 8 MiB per environment;
- private terminal result reads for the waiting Container, while `CONNECTOR_EVENTS` and the bounded
  local-only event outbox receive only request/status/timing metadata—never result bodies, failure
  detail, or idempotency keys;
- durable request receipts plus bounded result/subscription waits. Each private read waits at most
  25 seconds and wakes when terminal or subscription state changes; request IDs and delivery
  sequences make timeout, reconnect, and isolate-turnover reissue safe;
- alarm-driven request expiry, retention cleanup, stale/offline detection, cancellation, revocation,
  and disconnect handling.

Cloudflare documents why hibernatable sockets need serialized attachments and why timers prevent
hibernation in its [Durable Object WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
The hub therefore uses a Durable Object alarm—not `setInterval`—for deadlines and cleanup. Alarms are
at-least-once, so all cleanup paths are idempotent; see the [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/).

`DurableObjectConnectorRouter` and `ConnectorT3TransportBoundary` are the integration-facing APIs.
The latter defines stable tags for environment info, snapshots, thread detail, dispatch, RPC, and
thread subscription leases. The private Container control plane joins durable dispatch receipts,
terminal results, events, cancellations, and subscription leases to the shared `T3Transport` and
command-arbiter contracts.
`ControlPlaneConnectorRouterEntrypoint` exposes status, submit, result, revoke, and disconnect through
a named Worker RPC entrypoint. A control-plane Worker can bind directly to that entrypoint without a
public URL. Cloudflare documents that named
[Worker entrypoints are private Service Binding APIs](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/).
The shared-secret `/internal/environments/*` HTTP bridge now exists only for local development.

## Static console

Wrangler uploads `../dist/web` (the output configured by `frontend/vite.config.ts`) through the
`ASSETS` binding. API and internal paths run the
Worker first; other static paths are served directly. Unknown extensionless HTML routes fall back to
`index.html` for the React router. This follows Cloudflare's [Static Assets binding and routing
model](https://developers.cloudflare.com/workers/static-assets/binding/).

## Bindings and environments

`wrangler.jsonc` defines local, staging, and production environments. The repository also contains a
non-public fail-closed first-bootstrap stub and a separately protected bootstrap workflow. None has
been provisioned or deployed by this change.

| Binding | Runtime | Purpose | Current state |
|---|---|---|---|
| `ASSETS` | all | Vite console build | configured |
| `ENVIRONMENT_CONNECTOR_HUB` | all | per-environment socket/request coordination | implemented |
| `DEV_CONNECTOR_TICKETS` | local default environment only | atomic mock ticket issuance/consumption | implemented; absent from staging/production bindings and types |
| `CONTROL_PLANE` | staging/production | same-origin API, ticket consumption, and private capabilities | edge binding and sibling private Worker/Container implemented locally; not deployed |
| `CONNECTOR_EVENTS` | staging/production | connector state and metadata-only response projections to durable consumer | queue producer/consumer and private Container projector implemented locally; no hosted proof |
| `BACKGROUND_TASKS` | all | cloud-owned media/reconciliation/retention work | queue/Cron producers, consumers, and private Container executor implemented locally; no hosted proof |
| `BACKGROUND_QUARANTINE` | all | redacted terminal/retry-exhaustion envelopes | producer and broker DLQ configured; no hosted proof |
| `TELEMETRY` | all | aggregate request, DO capacity, Queue, connector, rollout, and Container signals | per-environment Analytics Engine binding and sampling implemented; no hosted ingestion/alert proof |
| `ROUTER_SHARED_SECRET` | local | protects the local-only backend-to-router HTTP bridge | `.dev.vars` only |
| `MEDIA_BUCKET` | not used | optional native Worker R2 binding | outside the current Container architecture; media uses the existing S3-compatible R2 adapter |
| `CONVEX_HTTP_BASE_URL` | not used | optional direct Worker projection integration | outside the current Container architecture; durable records use the existing Convex HTTP Store adapter |

The original `v1` Durable Object migration still lists `DevelopmentConnectorTicketStore`. That is
immutable deployment history and is deliberately retained instead of adding a destructive
`deleted_classes` migration. Staging and production expose no binding for the class, cannot select
`dev-do` authentication, and receive connector tickets only through the private `CONTROL_PLANE`
service binding.

For an authorized first staging deployment, use the protected
[`Staging bootstrap`](../docs/staging-bootstrap.md) workflow. It creates the configured
connector-event, background, and dead-letter Queues plus both named R2 buckets, then resolves the
reciprocal edge/control-plane Service Binding through a non-public fail-closed stub. The equivalent
Queue resources are:

```bash
npx wrangler queues create agent-controller-connector-events-staging
npx wrangler queues create agent-controller-background-staging
npx wrangler queues create agent-controller-dead-letter-staging
```

Both source consumers name the environment-specific dead-letter Queue and retry five times. Known
terminal failures and sixth-attempt retry exhaustion first publish a versioned quarantine envelope,
then acknowledge the source. The envelope contains an opaque SHA-256 message reference, source
class, attempt count, bounded failure code, task kind, and timestamp—never the task payload, task ID,
connector/environment/user identifiers, error message, or stack. If quarantine publication fails,
the source message is retried instead of dropped. Cloudflare's broker-side DLQ remains a final safety
net for crashes or delivery failures; with no active DLQ consumer it currently retains messages for
four days according to the [Queues DLQ documentation](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).

The sibling control-plane package implements the forwarded public `/v1` routes and named private
ticket, connector-event, and background capabilities. Its Container calls this Worker's
`ControlPlaneConnectorRouterEntrypoint` through a private Service Binding; it does not call the
local `/internal` HTTP route or expose the router on a public URL.

Both Worker packages emit the fixed, content-free `next-coder.cloud-telemetry.v1` schema to
their per-environment `TELEMETRY` Analytics Engine binding and, locally only, sampled structured
console logs. Automatic
invocation logs are disabled, and persistent Workers Logs/traces are held at a zero sample because
Cloudflare enriches them with raw URLs and paths. Analytics Engine and local-only structured console
events sample successes at 5% and ordinary rejected requests at 10%. Failures, capacity pressure,
connector transitions, Queue quarantine/DLQ risk, and rollout outcomes bypass application success
sampling. The field map, SQL, provisional dashboards/alerts, privacy review, and
hosted qualification procedure are in [Cloud observability](../docs/cloud-observability.md).

Native Worker R2 and direct Convex bindings are intentionally absent from `wrangler.jsonc`. The
current production design passes S3-compatible R2 credentials and Convex configuration only to the
private Container, preserving the repository storage adapter, ownership checks, and redaction
contracts. A future native-Worker storage path would require its own adapter and integration tests;
it is not a prerequisite for the current architecture.

## Local verification

From this directory:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run typecheck
npm test
npm run dev
```

`npm test` first builds the root console because Wrangler's asset binding targets the real Vite
output. A Node-side contract test validates the actual connector CLI's hello frame, then the Worker
Vitest integration runs tests in the Workers runtime and exercises atomic
single-use ticket consumption, WebSocket hello/welcome, Durable Object routing, bounded immediate-wake
result/subscription waits, terminal results, idempotent replay, queue quarantine, and offline failure.

The deployment commands build assets but do not provision dependencies:

```bash
npm run deploy:staging
npm run deploy:production
```

Do not run them until the environment resources and secrets above exist and an operator explicitly
authorizes deployment.

Authorized first-time staging provisioning should use the manual, separately protected
[`Staging bootstrap`](../docs/staging-bootstrap.md) workflow. After that succeeds, staging changes
use the GitHub-environment-protected [`Staging release`](../docs/staging-release.md) workflow. Release
validates the exact Queue, Service Binding, Analytics Engine/observability sampling, Durable Object
migration, R2, secret-name, and active-version contracts before mutation;
then deploys Convex -> private control plane/Container -> edge and captures redacted evidence. It
also provides an explicit compatibility-gated rollback. Release intentionally fails if the
reciprocal services and external resources have not already been bootstrapped. Neither workflow has
been executed from this repository.

## Remaining production proof

The edge, private Container, connector router, `T3Transport`, Queue/Cron ownership, application-level
quarantine, broker DLQ configuration, revocation, and reconnect paths are joined and tested locally.
After an explicitly authorized staging deployment, run the fail-closed
[`qualify:staging`](../docs/staging-qualification.md) gate. Its credential-free mode checks public
health and confirms that private capabilities, the local router, and the development ticket issuer
are absent from the public origin. With explicit test credentials/resources it can also prove fresh
connector/T3/provider readiness and, only behind a separate mutation flag, one completed first-agent
reply. The command emits redacted JSON and its automated tests use loopback mocks only; it has not
been run against a deployed service.

The remaining gates are external or live-system evidence:

1. provision the paid-plan Container, Service Bindings, Queues, broker DLQs, Convex deployment, R2
   buckets, secrets, and production CA roots, then deploy staging under explicit operator approval;
2. exercise ticket hashing/audience/ownership, credential rotation and online revocation through the
   deployed bindings and a real connector;
3. prove connector projection and background work against hosted Queues, including retry exhaustion,
   application quarantine, broker DLQ delivery/retention, Convex cursor writes, and S3-compatible R2;
4. measure the bounded result/subscription long-poll call rate and latency through the deployed
   Container-to-edge binding, including idle, active, timeout, reconnect, and backpressure loads;
5. run Durable Object eviction/deploy-rollover, machine sleep/wake, WAN loss, load, security, and
   end-to-end controller-to-cloud-to-connector-to-live-T3 tests;
6. confirm both Analytics Engine datasets ingest only the fixed schema, provision the documented
   dashboards/alerts, correlate native broker DLQ depth, and record Container cold-start/cost evidence.

`/health` derives control-plane, background Queue, and quarantine readiness from actual bindings. In
staging/production, a missing `CONTROL_PLANE`, `BACKGROUND_TASKS`, or `BACKGROUND_QUARANTINE` binding
fails health; missing control-plane binding also fails `/v1` and connector socket requests closed
with `control_plane_unconfigured`. No Worker has been deployed and no live cloud connector/T3 or
hosted Queue/DLQ flow has been observed.
