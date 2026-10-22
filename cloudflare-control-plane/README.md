# Next Coder control-plane Container

This isolated package makes the current Node `node:http` gateway callable as the Cloudflare edge
runtime's private `CONTROL_PLANE` Service Binding. It is a Worker in front of one explicitly bounded
Cloudflare Container instance; it does not make the Node application itself Worker-compatible.

```text
cloudflare/ edge Worker
  └─ CONTROL_PLANE Service Binding
      └─ private Worker (this package; no workers.dev URL)
          ├─ public /v1/* ────────────── container port 3996 ── createApp()
          └─ named /v1/internal/* capabilities ─ container port 3998 ── connector/background services
          └─ connector-router.internal ─ named edge WorkerEntrypoint ─ Durable Object hub ─ local connector
```

The second port is reachable only through the Container's Worker/Durable Object boundary. The
connector ticket/event service is never mounted in `createApp()` and `/v1/internal/*` remains `404`
on the public Node port. Ticket values stay in bounded request bodies and are not copied into URLs or
logs.

Connector-backed T3 calls take the reverse private path. Node calls the fixed
`http://connector-router.internal` virtual hostname; `AgentControllerGatewayContainer.outboundByHost`
intercepts it before internet egress and invokes the edge runtime's named
`ControlPlaneConnectorRouterEntrypoint` Service Binding. No public Node or Worker route exposes this
capability. Request bodies, terminal polling, cancellation, and thread subscription leases are
bounded at both sides of the bridge.

The Worker uses `AGENT_CONTROLLER_GATEWAY.getByName("agent-controller-control-plane")`, `max_instances: 1`, and
the `startGateway()` RPC method for ports 3996 and 3998. Only the string startup environment and a
timeout cross RPC; cancellation is created inside the Durable Object. The method retains the SDK's
`startAndWaitForPorts()` lifecycle, outbound interception, concurrent-start coalescing, and alarms,
with one deadline for the complete startup. No signal is passed in the Worker RPC arguments:
`enable_abortsignal_rpc` is experimental and Cloudflare rejects it on deployment. The SDK's native
port probes use the local signal. `pingEndpoint` is a host rather than a complete URL. This keeps the process-local event broker,
auth cache, and in-memory rate limiter coherent while the migration is incomplete. Durable product
records live in Convex; the container filesystem is not production state.

Startup failures return fixed error codes and emit only fixed diagnostic classifications and an
environment-key count. Platform error names, messages, codes, stacks, and causes are withheld because
they may contain startup credentials or request data. Local tests cover timeout bounds and redaction;
they do not establish hosted Container startup or live connector reachability.

This follows Cloudflare's current [Containers architecture](https://developers.cloudflare.com/containers/),
[getting-started configuration](https://developers.cloudflare.com/containers/get-started/), and
[container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/).
Container disk is ephemeral, and Cloudflare currently requires the Workers Paid plan.

## Production requirements

Staging and production fail startup unless all of the following are supplied as Worker secrets and
passed into the container:

- `PUBLIC_BASE_URL`, `CONVEX_URL`, and `GATEWAY_CONVEX_SECRET`;
- `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`;
- `T3_TOKEN_ENCRYPTION_KEY`;
- `S3_ENDPOINT`, `S3_BUCKET`, `FIRMWARE_S3_BUCKET`, `S3_ACCESS_KEY_ID`, and
  `S3_SECRET_ACCESS_KEY` for R2's S3-compatible API;
- `WEB_PUSH_VAPID_KEYS`, containing the bounded rotation-aware VAPID key set, and a separate
  `WEB_PUSH_STORAGE_ENCRYPTION_KEY` for sealing subscription capability URLs and keys at rest.

Optional secrets include `MEDIA_SIGNING_KEY`, `FIRMWARE_DOWNLOAD_SIGNING_KEY`,
`BILLING_WEBHOOK_SECRET`, `FACTORY_TOKEN`, `OTA_SIGNING_KEY`, `RATE_LIMIT_REDIS_URL`, and `S3_SESSION_TOKEN`.
These values are copied into the private Container only at startup; rotate the runtime after
changing a secret so a running process does not retain the previous environment.

The production console and gateway use `https://coder.next-notes.com`. The edge's production
custom-domain route is declared in `cloudflare/wrangler.jsonc`; set the production
`PUBLIC_BASE_URL` secret to that same origin so claim links and firmware download URLs agree.
Include the origin in `CLERK_AUTHORIZED_PARTIES`. Clerk's separate `clerk.next-notes.com`
Frontend API hostname also needs its instance-provided DNS records: an HTTP 200 from
`/v1/auth/config` does not prove the browser can resolve and load Clerk JS.
Manufacturing deployments should also provision `GATEWAY_TLS_ROOT_CA_PEM` and
`GATEWAY_TLS_NEXT_ROOT_CA_PEM`; both are passed through without logging so generated firmware trust
anchors stay aligned with the cloud endpoint.

Provision each value without putting it in `wrangler.jsonc`, for example:

```bash
npx wrangler secret put CONVEX_URL --env staging
npx wrangler secret put GATEWAY_CONVEX_SECRET --env staging
npx wrangler secret put CLERK_SECRET_KEY --env staging
npx wrangler secret put CLERK_PUBLISHABLE_KEY --env staging
npx wrangler secret put T3_TOKEN_ENCRYPTION_KEY --env staging
npx wrangler secret put PUBLIC_BASE_URL --env staging
npx wrangler secret put S3_ENDPOINT --env staging
npx wrangler secret put S3_BUCKET --env staging
npx wrangler secret put FIRMWARE_S3_BUCKET --env staging
npx wrangler secret put S3_ACCESS_KEY_ID --env staging
npx wrangler secret put S3_SECRET_ACCESS_KEY --env staging
npx wrangler secret put WEB_PUSH_VAPID_KEYS --env staging
npx wrangler secret put WEB_PUSH_STORAGE_ENCRYPTION_KEY --env staging
```

Repeat for production. The required `CONNECTOR_ROUTER` Service Binding is declared in every Wrangler
environment and production startup fails closed when it is absent. The runtime forces
`STORAGE_PROVIDER=convex`, Clerk auth, TLS, disabled dev
tokens, `DEPLOYMENT_MODE=cloud`, and S3-backed media/firmware in cloud environments. It also disables UDP discovery,
snapshot polling, live-thread scheduling, and transcription polling because permanent process timers
are not a safe Container lifecycle contract. It likewise forces `WEB_PUSH_WORKER_ENABLED=0`; the
edge Queue/Cron `push.deliver` task is the only managed-cloud delivery scheduler. Only the private
Container startup environment receives VAPID private material and the sealing key. The public
`/v1/push/config` projection contains support state, active key id, and the active public key only.

## Local verification and deployment

Docker is required for local Container development and deployment. Cloudflare documents this in its
[local development guide](https://developers.cloudflare.com/containers/local-dev/).

```bash
npm install
cp .dev.vars.example .dev.vars
npm run typecheck
npm test
npm run container:build
npm run container:smoke
npm run dry-run:staging
npm run dry-run:production
npm run dev
```

The two dry-run scripts validate the Worker/configuration with
`--containers-rollout=none`; `container:build` is the separate local image proof. A real deploy
builds and rolls out both components.

`container:smoke` rebuilds the actual repository image for Cloudflare's required `linux/amd64`
platform, then verifies its image metadata and a live process. The gate checks the non-root runtime,
the public health and private capability ports, public rejection of the private route, graceful
`SIGTERM`, the lock-pinned one-package production dependency surface, and the absence of secret-like
image environment variables or repository configuration files. The Docker context starts with `**`
and allows only `src/`, the Dockerfile, and the dedicated runtime manifests; the current checkout's
multi-gigabyte firmware, model, dependency, `.env`, `.data`, and `.dev.vars` content never enters the
build context. Buildx VCS labels are disabled because a macOS FileProvider-backed checkout can block
while Buildx implicitly hydrates `.git/HEAD`; CI provenance should be attached as an explicit
attestation instead.

Authorized deployment commands are available but were not run by this change:

```bash
npm run deploy:staging
npm run deploy:production
```

The repository's supported first-time staging path is the separately protected
[`Staging bootstrap`](../docs/staging-bootstrap.md) workflow. It first deploys a non-public,
fail-closed edge stub, then this private Worker without a Container rollout, provisions secrets via
standard input, deploys Convex, and finally deploys this Worker/Container plus the public edge. After
that succeeds, the manual protected [`Staging release`](../docs/staging-release.md) workflow deploys
Convex first, this private Worker/Container second with an immediate Container rollout, and the
public edge last.
An explicit compatible rollback restores edge first and then performs a full deploy of the older
private Worker/Container source; a Worker-version rollback alone would not restore the Container
image. No workflow run or external mutation is performed merely by adding that automation.

The edge package's existing staging/production `CONTROL_PLANE` service names match this package's
Worker names. Both services must be deployed in the same Cloudflare account for Service Binding
resolution.

The Worker records privacy-safe `container_request` telemetry through its per-environment Analytics
Engine binding: fixed operation/outcome/status classes, total duration, bounded startup-wait buckets,
and distinct startup versus response-header timeout families. It never records request URLs, paths,
identifiers, headers, bodies, or secrets. Analytics Engine and local-only structured console events sample
successes at 5%. Wrangler disables invocation logs and holds declared persistent Workers Logs/traces
at a zero sample because platform events include full URLs and paths. See [Cloud observability](../docs/cloud-observability.md)
for the schema, queries, alerts, and the hosted privacy/cold-start proof still required.

Once staging is deployed, use the repository-root
[`qualify:staging`](../docs/staging-qualification.md) command to verify the public health contract,
exact public `404` behavior for private capabilities, connector-first readiness, and the optional
completed first-command proof. That harness is post-deploy verification only; it does not provision,
deploy, or substitute for Queue/R2/Convex/rollover evidence.

## Known limits

- The singleton is deliberate. Raising `max_instances` requires shared rate limiting and a product
  design for process-local SSE/event fanout before load balancing is safe.
- A singleton rollout cannot be genuinely gradual; `rollout_step_percentage` is `100`, so operators
  must expect a cold start or brief unavailability and validate staged rollout behavior.
- Media and firmware use the existing S3-compatible adapter with R2 credentials. A native Worker R2
  binding/FUSE adapter is not part of this Container architecture; live R2 proof is still required.
- Process timers are disabled in the cloud Container. The edge Queue/Cron handlers own snapshot,
  media, retention, and connector projection work through the private background capability.
- Connector-mode T3 routing is wired through the private named entrypoint, but it has not been proven
  against a deployed Container, edge Worker, real connector process, or live T3 runtime.
- Container capacity and billing require a Cloudflare Workers Paid plan. No external service was
  provisioned or deployed by this work.
- Startup-wait telemetry identifies cold-start candidates but cannot prove that Cloudflare allocated
  a new Container. Hosted lifecycle, CPU/memory, alert delivery, and cost evidence remain required.
