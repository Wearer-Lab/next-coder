# Notifications and background liveness

Next Coder keeps a durable, in-app notification center for events that materially change an
operator's next action:

- agent turns complete or fail;
- gateway or provider approval is required;
- the agent asks for user input;
- a connector or T3 environment goes offline or recovers.

The records are an attention index, not a second transcript. They contain a kind, severity, title,
opaque notification id, optional environment/thread/command references, timestamps, and read or
dismissed state. They do not contain prompts, provider output, answers, paths, raw upstream request
ids, connector secrets, or diagnostic error text. Opening a linked resource performs its normal
authorization check.

## Delivery and replay

`GET /v1/notifications` is authoritative. Each record has an opaque cursor; a client can resume with
`after`, paginate in bounded batches, and safely process an overlapping SSE invalidation. Creation
uses an owner-scoped durable deduplication key, so retries and overlapping snapshot/live evidence do
not create duplicate records. Read, read-all, and soft-dismiss mutations are idempotent.

The store retains at most 1,000 records per owner for 30 days and evicts the oldest terminal or
dismissed records first. This bound applies consistently to memory, file, and Convex adapters.

The console optionally raises local OS notifications while its page or installed PWA is running in
the background. Permission is requested only after the operator opts in. Initial durable replay is
seeded silently, so opening the console does not announce an old queue. Notification bodies remain
content-free.

## Optional Web Push

Web Push is an explicit per-browser opt-in and is disabled unless the server has a valid VAPID key
set. The browser registers through `POST /v1/push/subscriptions`; subscription listing and revocation
remain owner-scoped. Endpoints are capability URLs, are never returned by public APIs or logged, and
are accepted only for HTTPS hosts in the configured push-service allowlist.

Delivery is a durable job, not request-path work. Notification creation queues one idempotent job per
active subscription. The Node adapter runs the worker on its own timer; Cloudflare Cron/Queue sends
the same `push.deliver` task to the private container boundary. Attempts are leased and capped at
five. Transport errors, 408/425/429, and 5xx responses retry with bounded backoff; 404/410 responses
revoke the dead subscription. An `accepted` record means only that a push service accepted the HTTP
request. It never claims that a device displayed a notification.

Payloads contain only a static title, static body, opaque notification id, and same-origin Activity
URL. The delivery worker re-reads the durable notification and subscription and skips dismissed,
revoked, or missing records. Prompts, transcripts, answers, paths, provider output, raw request ids,
environment ids, thread ids, command ids, and diagnostics never enter a push payload.

### VAPID configuration and rotation

Configure secrets through the deployment secret store. A single-key deployment may use:

```text
WEB_PUSH_VAPID_KEY_ID=primary
WEB_PUSH_VAPID_PUBLIC_KEY=...
WEB_PUSH_VAPID_PRIVATE_KEY=...
WEB_PUSH_VAPID_SUBJECT=mailto:ops@example.com
```

For rotation, set `WEB_PUSH_VAPID_KEYS` to a JSON array of at most three records with `keyId`,
`publicKey`, `privateKey`, `subject`, and exactly one `active: true`. Retain the previous private key
until old browser subscriptions have rotated; each subscription records the key id it used. Invalid
or partial configuration makes `GET /v1/push/config` report Web Push unavailable and the worker sends
nothing. `WEB_PUSH_ALLOWED_HOSTS` may override the comma-separated provider allowlist when an
operator has verified another browser push service.

Managed Cloudflare staging and production use the rotation-aware `WEB_PUSH_VAPID_KEYS` form and
require a separate `WEB_PUSH_STORAGE_ENCRYPTION_KEY`. Both are Worker secrets passed only to the
private Container. The protected release preflight verifies their names without reading values.
Queue/Cron owns delivery in cloud mode, so the Container's process timer is forced off.

The sender is the pinned `web-push` package, which implements RFC 8291 payload encryption and RFC
8292 VAPID. Next Coder does not implement those cryptographic protocols itself. Tests inject a
local mock sender and never contact a real push endpoint.

## Scheduled-worker liveness

`GET /v1/background/liveness` reports only platform scheduler execution evidence: last attempt,
success and failure timestamps, the next expected deadline, a bounded failure code, and one of
`healthy`, `degraded`, `stale`, `not_configured`, or `unknown`.

That status is deliberately separate from connector, T3, and provider health. A live connector does
not prove Queue/Cron work is running; a healthy scheduler does not prove a user's computer, T3, or
provider is reachable. The console labels those layers independently and never fabricates a healthy
background state from browser SSE heartbeats or device presence.
