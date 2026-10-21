# Production Security And OTA Rollback

Covers roadmap Phase 4 (minimum production security) and the Phase 12 OTA pipeline.

Each item below is split into the part the code enforces and the part a human must perform. The
human half is deliberately not automated: burning eFuses is irreversible, and a mistake bricks the
board permanently.

## TLS only

Enforced by the gateway. Set:

```text
REQUIRE_TLS=1
```

With this set, the gateway refuses to **issue or accept a device credential** over plaintext. That
covers device registration, claiming, secret rotation, transfer reset, factory provisioning, and
every device-authenticated request.

Loopback is exempt so the simulator and local flashing keep working — but only when no proxy
forwarded the request. Once `x-forwarded-proto` is present the real client is elsewhere, so its
scheme decides, and a loopback socket grants no exemption. Terminate TLS at a proxy that sets
`x-forwarded-proto` correctly, or serve HTTPS directly.

Requests that carry no credential (health, the plan catalogue, static assets) are unaffected.

The controller verifies the gateway certificate too. Manufacturing configuration defaults
`INSECURE_SKIP_TLS_VERIFY` to `0` and injects `GATEWAY_TLS_ROOT_CA_PEM` from the gateway process
environment. `GATEWAY_TLS_NEXT_ROOT_CA_PEM` can carry the next issuing root during a planned CA
rotation. Firmware refuses HTTPS until a root is configured and SNTP has established a credible
clock. An insecure override remains available only to an explicit local bench build; secure/product
build flags override it back to fail-closed behavior.

## OTA with rollback

Rollback needs three things. The first two are code and are in place:

1. **A dual-app partition table** — `partitions_ota.csv`. A single-app layout cannot roll back at
   all, which is why `ENABLE_OTA_APPLY` defaults to `0` without it.
2. **Self-confirmation after boot** — `confirmFirmwareIfPendingVerify()` in `src/main.cpp`. The
   bootloader marks a newly flashed image `PENDING_VERIFY`; the firmware confirms it only after a
   **successful gateway heartbeat**. An image that boots but cannot reach the gateway is rolled
   back on the next reset instead of stranding the controller.
3. **Bootloader rollback enabled** — requires a bootloader actually built with
   `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`. The macro visible to an Arduino application is not
   proof of the prebuilt bootloader's behavior. On the CrowPanel hardware the distributed
   Arduino-ESP32 bootloader marked the first OTA boot `VALID`, so firmware also persists a boot
   attempt counter and returns to the other OTA slot after a pre-heartbeat restart. That fallback
   covers images that reach `DeviceStore::begin()`; a custom ESP-IDF bootloader is still required
   to recover failures earlier than application setup.

Build with OTA apply and signature enforcement on:

```bash
pio run -e crowpanel-esp32-213-epaper-secure
```

Publish signed release metadata from the gateway with `OTA_SIGNING_KEY` set:

```bash
npm run firmware:publish
```

### Rollback test — do this before shipping

Not automatable, and Phase 12 is not complete without it:

1. Flash a known-good build and let it heartbeat successfully.
2. Build a drill image with `NEXT_CODER_OTA_ROLLBACK_DRILL=1`; it restarts before networking.
3. Let the device apply it.
4. Confirm the device selects the previous slot on its second boot, heartbeats again, and reports
   `rolled_back`. A bootloader-level drill must separately use an image that fails before setup.

Until both application-level and custom-bootloader drills pass on real hardware, do not represent
early-boot rollback as production-complete.

## Secure boot and flash encryption

The roadmap says "where practical". These are **eFuse operations and are irreversible**. The build
configuration is provided; the key ceremony is not, and must not be scripted casually.

Before enabling, decide and write down:

- Where the signing key lives (an HSM or offline media — never the repository, never CI logs).
- Who can sign a release, and how that authority is revoked.
- Whether you can still service a returned unit once JTAG and UART download are restricted.
- Your recovery story for a unit that fails signature verification in the field.

Only then follow Espressif's ESP32-S3 secure boot v2 and flash encryption procedures. Enable flash
encryption in **release** mode for production units; development mode leaves the device
re-flashable and is not a production posture.

A unit with secure boot burned cannot run an unsigned image, including your own debug builds. Keep
a separate unfused development unit.

## What the gateway already enforces

- Per-device credentials, stored only as SHA-256 hashes and compared with `timingSafeEqual`
- Secret rotation, transfer reset, and revocation, all audited
- Connector credentials stored as hashes; T3 access and pairing tokens remain on the user machine in cloud mode
- T3 access tokens sealed with AES-256-GCM at rest for the self-hosted direct compatibility mode
- Signed firmware release manifests (`OTA_SIGNING_KEY`)
- Firmware version tracking per device
- Rate limits per user, device, and factory client
- Redaction of secrets, claim codes, transcripts, and vision descriptions from support bundles
- Notification rows and SSE events use static content-free titles plus authorized navigation ids;
  private dedupe hashes, prompts, transcripts, paths, answers, and provider detail are not exposed

## Browser response boundary

Both the Node reference adapter and the Cloudflare edge apply the same browser policy to the console,
JSON APIs, SSE, and media responses. The policy denies framing through CSP `frame-ancestors` plus
`X-Frame-Options`, disables content sniffing, suppresses referrers, and denies device capabilities the
console does not use. Camera and microphone remain same-origin because image and voice capture are
product features.

The CSP is same-origin by default. Its narrow external exceptions are Clerk's hosted script, API,
WebSocket, image, and frame origins plus Cloudflare's Clerk challenge frame. Inline styles remain
allowed because Clerk's hosted components set runtime styles; inline scripts, arbitrary frames,
plugins, cross-origin forms, and cross-origin media stay blocked. Blob media and workers remain
allowed for local capture playback and the PWA lifecycle. If the Clerk deployment moves to a custom
Frontend API or adds another challenge provider, update both `src/securityHeaders.mjs` and
`cloudflare/src/securityHeaders.ts` together and prove sign-in, sign-up, profile, service-worker,
SSE, camera, microphone, and signed-media behavior at the hosted origin before rollout.

The in-app notification center is authoritative. Optional Web Push is separately opt-in and remains
disabled without a valid server-side VAPID key set. Push endpoints are owner-scoped bearer
capabilities, public projections redact them, registration applies an HTTPS provider-host allowlist,
and 404/410 delivery responses revoke them. Payloads are static and content-free. An accepted push
request is not proof of device display. Rotation, retry, revocation, and deployment configuration are
documented in [`notifications.md`](notifications.md).

## Cloud T3 boundary

`DEPLOYMENT_MODE=cloud` makes connector enrollment the only way to add a T3 environment. The gateway
returns 404 from the legacy code-redeem route and 409 from manual direct creation before claiming a
code, parsing a caller-supplied T3 URL or credential, exchanging a token, or making network requests.
An existing connector environment can change its label, but cannot accept `baseUrl`, `accessToken`,
`pairingToken`, `scopes`, `transportMode`, or other routing/credential fields.

The transport resolver independently rejects persisted legacy direct environments in cloud mode.
This second boundary matters during migration: even if an old direct record is imported, an API,
device request, background runner, or media-title lookup cannot turn its stored `baseUrl` into an
SSRF-capable outbound request. Self-hosted mode retains direct pairing and transport compatibility.

### Connector credential rotation

An owner-authorized rotation keeps one connector id and never stores a plaintext connector secret
in cloud state. The active hash remains valid while a second hash is staged for at most ten minutes.
The pending authenticator carries both the next integer generation and an unguessable rotation id;
both are required to mint its ticket, which prevents an abandoned staged secret from racing a newer
attempt that happens to use the same generation number. Consuming the staged ticket atomically
promotes its hash, clears the pending fields, and retires every unconsumed old-generation ticket.
Old standing credentials cannot mint after that commit. Revocation clears active and pending hashes,
invalidates all unused tickets, and propagates an immediate live-socket close.

The CLI keeps a private interruption journal until a temporary connector bridge has authenticated
and the managed service has superseded it. The bridge emits only the opaque rotation id and timestamp;
standing secrets never enter connector frames, events, logs, audit metadata, or diagnostics. File
fallback requires owner-only permissions, while supported native stores may keep active and staged
secrets outside the JSON metadata entirely. Rotation codes are purpose-bound and cannot be confused
with T3 enrollment codes. Runtime telemetry is isolated in a private sidecar so an old managed process
cannot overwrite the credential journal during handoff.

## Connector result retention

Connector terminal results can contain private T3 output. The environment Durable Object retains
them only for the synchronous private result-read contract and deterministic request replay: at most
1,000 terminal results and 8 MiB of serialized terminal-result data per environment, for at most 24
hours, with oldest-first count/byte eviction and alarm-driven expiry cleanup. The 8 MiB aggregate
budget matches the local connector's completed-request cache; the connector protocol's 1 MiB frame
limit remains the per-result ceiling. Request, subscription, and delivery buffers have separate
count/byte/deadline bounds.

`CONNECTOR_EVENTS` and the local development event outbox never receive the terminal result body,
failure detail, or idempotency key. Their `connector.response` projection contains only the opaque
request ID, terminal status, completion timestamp, duration, and—on failure—a bounded failure code
plus retryability. The private Container waiter still receives the complete terminal result directly
from the environment Durable Object. If count or byte pressure evicts that body while its compact
idempotency receipt remains, replay fails closed with `connector_result_evicted` and does not dispatch
the local operation again. Terminal results are not support-diagnostic or audit projections and must
never be copied into logs, Queue quarantine metadata, or telemetry.

This is a deliberate cloud data-retention boundary, not proof of a deployed privacy control. Before
production, verify cleanup and deletion in a real Durable Object, document the customer-facing
retention policy, and decide whether the beta requires a shorter window or application-layer
encryption in addition to Cloudflare's platform storage protections.

## Repository secret gate

Run this before any release artifact is built:

```bash
npm run security:repo
```

The gate fails closed if it cannot enumerate Git's tracked files. It rejects live board
`controller_config.h` variants, environment/runtime data, private-key files, and a small set of
high-confidence credential signatures; reports paths and rule names only, never matched values.
Example configuration files remain allowed.

This checkout still has CrowPanel `controller_config.h` and `controller_config.old.h` variants in
the Git index. Existing ignore rules protect only future untracked files. Remove those exact files
from tracking while preserving the maintainer's local copies, inspect repository history through an
approved secret-remediation process, and rotate any credential that may have appeared before
publishing or deploying. History rewriting and external credential rotation require maintainer
authority and are not performed by the gate.

The release scanner and ignore rules allow only `controller_config.example.h`; local, backup,
editor, and future `controller_config*` variants are blocked without reading or printing their
contents. The release checkout is not clean for CG-10 until `git ls-files` excludes both live
variants and the credential rotations are recorded outside the repository.

## Public release identity blockers

Two of the three former blockers were resolved on 2026-09-08. The repository and package license is
Apache-2.0, present at the root and at `packages/connector/LICENSE` and declared in both manifests,
and `packages/connector/package.json` carries `repository`, `homepage` and `bugs` metadata naming
the real public repository. The protected release helper fails closed on an unresolved license, a
tarball without `LICENSE`, or absent repository metadata, and now passes all three.

What remains is not a repository state: the maintainer must ratify Apache-2.0 as a deliberate legal
choice rather than an inherited default, and the npm trusted publisher, its allowed-actions setting,
and the protected `npm-release` environment must be configured before any publication.
See [npm-connector-release.md](npm-connector-release.md).
