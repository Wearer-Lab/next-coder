# Remote access

Next Coder has two deliberately different remote-access models:

1. **Managed cloud (the production design):** controllers and browsers connect to the stable Next
   Coder HTTPS/WSS origin. A connector running beside T3 Code initiates an authenticated
   outbound connection to that cloud service and proxies T3 commands and events.
2. **Self-hosted/advanced:** an operator exposes a locally running gateway or T3 server through
   Tailscale Serve, Funnel, or another independently secured network path.

Do not combine the two into one setup contract. Managed cloud does not require the cloud service to
join a user's Tailnet, reach a LAN address, or accept a standing T3 token. Direct Tailscale/Funnel
gateway access remains useful for development and self-hosting, but it is not the production cloud
topology.

## Production: cloud service plus outbound connector

The intended path is:

```text
controller or browser ── HTTPS/WSS ── Next Coder cloud
                                         │
                                         └── authenticated WSS ── connector CLI ── local/Tailnet T3
```

The local connector:

- redeems a short-lived, single-use code created by the signed-in user;
- receives a revocable environment-scoped credential, separate from platform, device, factory, and
  T3 credentials;
- discovers or safely launches T3 on the user's machine;
- stores the T3 access material locally rather than sending it to the cloud;
- maintains heartbeat, reconnect, replay, backpressure, and truthful offline/reconnecting state;
- proxies commands, events, terminal results, approvals, questions, cancellation, and thread
  subscriptions over the outbound channel.

The repository contains the connector package and its `bin` entry. The eventual install-free command
has this shape:

```bash
npx @wearer-haitch/connector connect \
  --server 'https://controller.example.com' \
  --code 'one-time-code'
```

The package has not been published, and the managed cloud has not been deployed from this checkout.
Until publication, developers can run the package from a repository checkout; that is local evidence,
not proof of the install-free production journey.

When `DEPLOYMENT_MODE=cloud`, connector enrollment is the supported T3 path. Direct environment URL
and token creation are disabled, and onboarding intentionally hides gateway Serve/Funnel controls.
Readiness is proof-gated: a socket acknowledgement alone does not count as a working environment.
The flow must observe the selected environment, project, provider and model, then a completed command
with a newer T3 reply before presenting the journey as ready. That contract is locally tested; a
deployed first-reply journey remains unproven.

## Where Tailscale belongs in production

Tailscale may run on the same user machine as T3 and the connector. It can provide a private route
from the connector to a T3 process elsewhere in that user's Tailnet, but it is not required when T3
is reachable over loopback.

Production rules:

- ESP32 controllers do not run Tailscale.
- The Next Coder cloud account does not join the user's Tailnet.
- No inbound port or public T3 endpoint is required for the common path.
- Tailscale access does not replace Next Coder authentication or connector authorization.
- Cached environment state must be shown as stale/offline until the connector proves liveness.

The packaged connector reports this optional layer through `status` and `doctor`. It performs only a
bounded `tailscale status --json` read and emits a privacy-minimal projection; raw peer, user,
Tailnet, hostname, and address data never enters its report. Missing or disconnected Tailscale adds
static, operator-directed guidance but does not make connector health fail by itself. The actual T3
reachability check remains authoritative.

The connector does not install Tailscale, run `tailscale up`, authenticate the machine, or inspect or
change Serve/Funnel configuration. Those are explicit operator actions. This keeps the managed cloud
path outbound-only and prevents a diagnostic or enrollment command from changing an independently
managed network boundary.

## Self-hosted/advanced: expose a local gateway

The commands in this section apply to a gateway that the operator runs locally. They are not needed
for the managed-cloud service.

### Private Tailscale Serve

Tailscale Serve gives a self-hosted gateway a stable MagicDNS HTTPS URL and limits access to devices
and users permitted by the Tailnet policy.

Prerequisites:

- Install [Tailscale](https://tailscale.com/download) on the gateway host.
- Sign in and confirm `tailscale status` reports the device as connected.
- Install Tailscale on each remote phone or computer that should open the private URL.
- Keep Next Coder authentication enabled. Tailnet access is an additional boundary, not a
  replacement for Clerk.

Run:

```bash
npm run setup:tunnel -- --mode serve --write-env
```

The command checks Tailscale, proxies HTTPS to `http://127.0.0.1:3996`, prints the MagicDNS URL,
updates `PUBLIC_BASE_URL`, and appends the origin to `CLERK_AUTHORIZED_PARTIES`. Restart the gateway
after `.env` changes:

```bash
npm start
```

Disable the persistent mapping with:

```bash
npm run setup:tunnel -- --mode serve-off
```

### Public Tailscale Funnel

Funnel publishes the self-hosted gateway to the public internet. Use it only when the client cannot
join the Tailnet and public reachability is intentionally required:

```bash
npm run setup:tunnel -- --mode funnel --write-env
```

The setup command refuses Funnel when Next Coder uses development authentication. The
`--allow-public` override is for operators who have independently installed another production
authentication layer; it is not a safe bypass for an unprotected gateway.

Before using Funnel, verify Clerk at the public origin, retain rate limits, keep all credentials out
of URLs and screenshots, and revoke unrecognized sessions. Disable the mapping with:

```bash
npm run setup:tunnel -- --mode funnel-off
```

## Self-hosted/advanced: direct T3 compatibility path

The repository retains a direct environment transport for development and self-hosting. A running T3
server can configure Tailscale Serve and mint a one-time pairing credential with:

```bash
npx t3 pair --tailscale
```

A repository-managed local environment can use:

```bash
npm run setup:t3 -- --project '/path/to/project' --tunnel tailscale
```

This path requires the self-hosted gateway to reach the T3 Serve URL. If they run on different
machines, both machines need an allowed Tailnet path. It also means the gateway participates in the
T3 trust boundary, so protect T3 credentials and keep authentication enabled.

Do not use this direct URL/token flow as a workaround in cloud mode. The public cloud service must
not make arbitrary requests into LAN, Tailnet, or user-supplied origins; the connector is the
application bridge and SSRF boundary.

## LAN hardware in self-hosted mode

ESP32 controllers do not normally run Tailscale. For a self-hosted gateway reached over local Wi-Fi,
listen on the LAN interface:

```env
HOST=0.0.0.0
```

Point the device at the gateway host's LAN URL, for example `http://192.168.1.162:3996`. Use HTTPS
with verified trust anchors for any production credential path; plain HTTP is a local-bench path.
If no LAN devices need the gateway, binding to `127.0.0.1` reduces direct LAN exposure.

## Troubleshooting

### The managed-cloud connector will not become ready

- Confirm the connector is using the exact cloud origin and an unexpired one-time code.
- Check that local T3 is running or that the connector can launch it.
- Distinguish `offline`, `reconnecting`, `accepted`, `completed`, approval, and user-input states;
  an accepted dispatch is not a completed agent turn.
- Re-enroll after credential revocation or rotation. The old socket should be closed and must not
  resume with the replaced credential.
- A local contract test does not prove hosted Service Binding, WAN, sleep/wake, or live-T3 behavior.

Run `next-coder-connect doctor --json` for the redacted cloud, T3, service, credential-storage,
and optional Tailscale projection. If its `tailscale.guidance` array contains an action and this T3
path actually uses the Tailnet, complete that action yourself and rerun doctor. Do not configure
Serve for the managed-cloud connector; its cloud channel is outbound.

### The self-hosted setup command cannot find Tailscale

Install Tailscale, launch the app, sign in, and run `tailscale status`. On macOS, the setup command
checks both `PATH` and the standard Tailscale application CLI location.

### The self-hosted HTTPS URL exists but sign-in fails

- Restart Next Coder after `--write-env` changes `.env`.
- Confirm `PUBLIC_BASE_URL` is the printed HTTPS origin.
- Confirm `CLERK_AUTHORIZED_PARTIES` includes that origin.
- Add the origin in Clerk if the frontend reports an origin or redirect restriction.

### Serve works on the host but not the phone

Confirm the phone is signed in to Tailscale, both devices appear in `tailscale status`, Tailnet ACLs
allow the path, and `tailscale serve status` reports the proxy.

### Funnel is not immediately reachable

The first Funnel setup can require administrator consent, MagicDNS, HTTPS certificates, and the
Funnel node attribute. Follow the URL printed by the Tailscale CLI and retry after approval.

## References

- [T3 Code remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)
