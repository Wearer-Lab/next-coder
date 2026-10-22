# Next Coder API

This is the initial platform API for device management and T3 Code orchestration.

For the ESP32 firmware-facing flow, see [hardware-protocol.md](hardware-protocol.md).

## Gateway Profiles

Owners manage reusable device origins with `GET/POST /v1/gateway-profiles` and
`GET/PUT/DELETE /v1/gateway-profiles/:id`. A profile is
`{id,label,mode:"lan"|"tailnet"|"custom",url}`. URLs are origins only: Tailnet profiles require
HTTPS `.ts.net`, custom profiles require HTTPS, and plaintext LAN profiles require a private,
link-local, localhost, or `.local` host.

`PUT /v1/devices/:id/gateway` with `{profileId}` stages a revisioned switch. The controller reads
`GET /v1/device/gateway`, probes the candidate with its existing device credential, and reports
`POST /v1/device/gateway/switch` with `{revision,profileId,status:"requested"|"applied"|"failed",detail?}`.
Only an exact revision and owned profile can be promoted. Failure retains the active profile;
`POST /v1/devices/:id/gateway/rollback` cancels a pending switch.

Authenticated owners can enable or disable private Tailnet-only Serve with
`POST /v1/settings/remote-access/serve` and `{enabled:boolean}`. Enabling first disables Funnel on
the same port and verifies Tailscale reports `tailnet only`.

Factory operators can upload an immutable binary with
`POST /v1/factory/firmware/releases/upload?version=...&channel=stable&hardwareModel=...` using
`application/octet-stream`. The gateway computes SHA-256 and size, stores the artifact on disk or
private S3/R2, and emits an authenticated device-download URL. Bucket credentials and object keys
are not exposed.

Managed artifact URLs in a device firmware manifest carry short-lived `expires` and `token`
parameters. The HMAC capability is scoped to the artifact SHA-256 and hardware model, allowing
legacy firmware that cannot attach device headers to complete one OTA hop. New firmware should
continue sending device headers. Capabilities are rejected after expiry and cannot be reused for a
different artifact or hardware model.

## Device Profiles

Discover supported device profiles:

```http
GET /v1/device-profiles
```

Profiles define the capabilities the policy engine will allow for a device:

- `next-coder`: prompts, media prompts, status, approvals, agent questions, session control, and policy-screened shell input.
- `read-only`: status only.
- `power-controller`: high-trust control profile for signed-in web clients and advanced devices; dangerous shell input still requires approval.

## Platform User Auth

The React application authenticates through Clerk. API clients send a current Clerk session token:

```text
authorization: Bearer CLERK_SESSION_TOKEN
```

Same-origin event streams may authenticate with the Clerk session cookie instead of placing a token in the URL. The gateway synchronizes the verified Clerk user ID, name, and primary email before serving user-owned data.

The legacy development-token route is enabled only when `AUTH_PROVIDER=dev` or `DEMO_MODE=1`. It is disabled in Clerk mode and is not part of the React UI.

Read public browser auth settings:

```bash
curl http://127.0.0.1:8877/v1/auth/config
```

This endpoint exposes the auth provider and Clerk publishable key only. It never returns `CLERK_SECRET_KEY`.

## Initial Onboarding

Authenticated React users are guided through T3 host configuration, environment pairing,
workspace/model selection, a first thread, and a controller or browser-only choice.

Read durable progress and server-derived readiness:

```http
GET /v1/onboarding
authorization: Bearer CLERK_SESSION_TOKEN
```

Persist a partial step update:

```http
PUT /v1/onboarding
authorization: Bearer CLERK_SESSION_TOKEN
content-type: application/json

{
  "status": "in_progress",
  "currentStep": "connect",
  "networkMode": "tailscale",
  "networkUrl": "https://machine.tailnet.ts.net",
  "provider": {
    "harness": "openai",
    "instanceId": "codex",
    "model": "gpt-5.4"
  },
  "workspace": {
    "path": "/work/next-coder",
    "title": "Next Coder"
  }
}
```

Nested provider, workspace, and device values merge with prior progress. Completion returns
HTTP 409 until the server can prove every requirement: reachable owned environment, selected
project/provider/model, a matching accepted `thread.launch` command for those exact selections, and either browser-only
operation or a non-revoked controller configured to that environment and thread. Registered
development controllers also require `device.credentialConfirmed: true`.

See [onboarding-flow.md](onboarding-flow.md) for the activation definition and recovery behavior.

## Rate Limits

The gateway applies fixed-window limits after authentication:

- Auth/dev token creation: keyed by client IP.
- Factory routes: keyed by client IP.
- User reads/writes: keyed by platform user ID.
- Device heartbeat/read/write routes: keyed by device ID.

Defaults:

```text
RATE_LIMIT_WINDOW_MS=60000
AUTH_RATE_LIMIT=30
FACTORY_WRITE_RATE_LIMIT=30
USER_READ_RATE_LIMIT=240
USER_WRITE_RATE_LIMIT=60
DEVICE_HEARTBEAT_RATE_LIMIT=120
DEVICE_READ_RATE_LIMIT=120
DEVICE_WRITE_RATE_LIMIT=30
```

When a limit is exceeded, the API returns:

```http
HTTP/1.1 429 Too Many Requests
x-ratelimit-limit: 30
x-ratelimit-remaining: 0
x-ratelimit-reset: 2026-06-14T21:00:00.000Z
retry-after: 42
```

```json
{
  "error": {
    "message": "Rate limit exceeded.",
    "details": {
      "scope": "device:write",
      "limit": 30,
      "remaining": 0,
      "resetAt": "2026-06-14T21:00:00.000Z"
    }
  }
}
```

## Device Registration

Development shortcut:

```http
POST /v1/devices
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "Desk controller",
  "profile": "next-coder"
}
```

Response includes a one-time device secret:

```json
{
  "device": {
    "id": "dev_...",
    "userId": "user_dev",
    "label": "Desk controller",
    "profile": "next-coder"
  },
  "secret": "..."
}
```

Commercial factory flow:

```http
POST /v1/factory/devices
authorization: Bearer FACTORY_TOKEN
content-type: application/json
```

```json
{
  "label": "Controller batch A",
  "profile": "next-coder"
}
```

Response:

```json
{
  "device": {
    "id": "dev_...",
    "userId": null,
    "claimed": false
  },
  "secret": "FLASH_THIS_TO_DEVICE",
  "claimCode": "ABCDE-23456"
}
```

If `DEMO_MODE=1` and no `FACTORY_TOKEN` is configured, the factory endpoint is open for local development only.

Batch-create factory devices and flash artifacts:

```http
POST /v1/factory/batches
authorization: Bearer FACTORY_TOKEN
content-type: application/json
```

```json
{
  "count": 10,
  "labelPrefix": "Next Coder",
  "profile": "next-coder",
  "gatewayBaseUrl": "https://gateway.example.com",
  "hardwareModel": "e213-esp32-s3r8",
  "firmwareVersion": "0.1.0",
  "enableOtaApply": false,
  "requireOtaSignature": false,
  "otaManifestVerifyKey": ""
}
```

There are no `wifiSsid`/`wifiPassword` fields: the factory cannot know the customer's network, so
Wi-Fi is entered by the owner through the on-device SoftAP portal.

The response includes, per device, a one-time `secret`, the customer `claimCode`, an `nvsSeed` CSV,
and generated `controller_config.h` content. Save those artifacts immediately; secrets are not
recoverable later.

`nvsSeed` is the production artefact — feed it to `nvs_partition_gen.py` and write the resulting
image at the NVS partition offset, so a line flashes one signed application image per batch and
varies only a small data partition:

```bash
python nvs_partition_gen.py generate dev_x.nvs.csv dev_x.nvs.bin 0x5000
esptool.py write_flash 0x9000 dev_x.nvs.bin
```

It carries `dev_id`, `dev_secret`, `gw_url`, `claim_code`, and `claim_exp`. The claim code is
included deliberately: the gateway will not reissue a still-live code's plaintext, so a unit that
did not leave the line holding its own code could never display one — the screen would read "no
code" while the printed label carried the real thing.
`enableOtaApply` controls whether generated firmware configs only report available updates or automatically download and apply them. The current signature prototype uses HMAC; do not ship one shared HMAC key broadly in production hardware.

Claim a pre-provisioned device:

```http
POST /v1/devices/claim
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "claimCode": "ABCDE-23456",
  "label": "Desk controller"
}
```

Rotate a claimed device secret:

```http
POST /v1/devices/dev_.../rotate-secret
authorization: Bearer PLATFORM_TOKEN
```

Reset a claimed device for resale, support replacement, or account transfer:

```http
POST /v1/devices/dev_.../transfer-reset
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "Refurbished desk controller"
}
```

The response includes a new one-time `secret` and customer `claimCode`. The device is unclaimed, removed from the previous owner's inventory, its runtime config/status are reset, and the previous hardware secret stops working immediately. Save the new secret and claim code immediately; they are not recoverable later.

Revoke a claimed device:

```http
POST /v1/devices/dev_.../revoke
authorization: Bearer PLATFORM_TOKEN
```

Permanently remove a revoked device from the inventory:

```http
DELETE /v1/devices/dev_...
authorization: Bearer PLATFORM_TOKEN
```

Only a revoked device can be deleted; an active one returns `409`. Revocation kills the credential
first, so the record can go without leaving hardware in the field that still authenticates against a
device the owner can no longer see. Commands and audit entries reference the device by id and are
kept — deleting the controller does not erase the record of what it did.

Every device payload carries an `actions` block saying which of these the gateway will currently
accept, so clients do not have to re-derive it from `revokedAt`:

```json
{
  "actions": {
    "rotateSecret": false,
    "transferReset": false,
    "updateConfig": false,
    "updateProfile": false,
    "revoke": false,
    "delete": true
  }
}
```

An older gateway omits the block; treat a missing field as permitted and let the request fail.

Update a claimed device's policy profile:

```http
PUT /v1/devices/dev_.../profile
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "profile": "read-only"
}
```

Unknown profiles are rejected. Profile changes affect the next device or web intent immediately.

Configure a claimed device's runtime defaults:

```http
PUT /v1/devices/dev_.../config
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "defaultPrompt": "Continue the current task, inspect progress, and run relevant tests.",
  "shellCommand": "npm test",
  "menu": ["status", "prompt", "shell", "macro", "media", "stop"]
}
```

Read a device config from the platform:

```http
GET /v1/devices/dev_.../config
authorization: Bearer PLATFORM_TOKEN
```

## Device Authentication

Device endpoints require:

```text
x-device-id: dev_...
x-device-secret: ...
```

Unclaimed devices can heartbeat and request a setup code, but cannot access display, media, events, or T3 control endpoints until claimed.

Fetch the setup code for an authenticated unclaimed device. The code is **stable**: while the
existing one is unexpired this returns `200` with `setup.rotated: false` and `setup.claimCode: null`,
so a device polling after its first `403` cannot invalidate the code printed at manufacture. Pass
`{"rotate": true}` to deliberately replace it, which answers `201` with the new plaintext.

```http
POST /v1/device/setup-code
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

```json
{ "rotate": false }
```

Response:

```json
{
  "device": {
    "id": "dev_...",
    "claimed": false
  },
  "setup": {
    "claimed": false,
    "rotated": true,
    "claimCode": "ABCDE-23456",
    "claimCodeExpiresAt": "2026-09-06T09:48:18.923Z",
    "instructions": "Sign in to the Next Coder dashboard and claim this device with the displayed code."
  },
  "claimCode": "ABCDE-23456",
  "claimCodeExpiresAt": "2026-09-06T09:48:18.923Z"
}
```

This route is intended for the physical controller's setup screen. Codes expire 30 days from issue,
and an expired code is refused at claim time (`404`) rather than treated as unknown. Only a rotation
retires a previously printed or displayed code.

`POST /v1/devices/claim` answers `404` with "Claim code is invalid, expired, or already used." for
all three cases; the `/claim?device=…&code=…` deep link surfaces that as an explicit dead end with a
route to manual entry.

Heartbeat can include lightweight diagnostics. The gateway stores the latest values on the device record and exposes them in `/v1/devices` and `/v1/device/display`:

```http
POST /v1/device/heartbeat
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

```json
{
  "firmwareVersion": "0.1.7",
  "hardwareModel": "e213-esp32-s3r8",
  "ipAddress": "192.168.4.20",
  "wifiRssi": -61,
  "freeHeap": 184320,
  "uptimeMs": 120000,
  "batteryMv": 4100,
  "batteryPercent": 87
}
```

Device responses include computed presence metadata. A device is `online` when its latest activity, either `lastSeenAt` or `status.lastHeartbeatAt`, is within 90 seconds:

```json
{
  "presence": {
    "state": "online",
    "online": true,
    "lastSeenAt": "2026-06-16T19:00:00.000Z",
    "lastHeartbeatAt": "2026-06-16T19:00:00.000Z",
    "latestActivityAt": "2026-06-16T19:00:00.000Z",
    "ageMs": 250,
    "staleAfterMs": 90000
  }
}
```

## Phone companion handoff

A signed-in owner or claimed controller can create a five-minute phone capture handoff. The handoff
is pinned to one owned environment, one thread, and one action (`record_audio` or `capture_image`).
It contains no prompt, transcript, device secret, or T3 credential.

```http
POST /v1/companion-handoffs
authorization: Bearer PLATFORM_TOKEN
content-type: application/json

{ "environmentId": "env_...", "threadId": "thread_...", "action": "record_audio" }
```

Claimed hardware uses `POST /v1/device/companion-handoffs` with its device credential. Omitted
`environmentId` or `threadId` falls back to the controller's current configuration. Both creation
routes return the redacted handoff, a `launchUrl`, and the same `qrPayload`. The owner route also
returns a locally encoded `qrSvg` for its web dialog; the constrained device response omits that
larger rendering and lets board firmware render `qrPayload` for its own display. The bearer appears
only after `#` in `/#/media?handoff=...`; browsers do not send fragments in HTTP requests or
referrers, and the PWA removes it from the visible URL immediately after reading it. No external QR
service receives the payload.

After platform sign-in, the phone atomically consumes the code:

```http
POST /v1/companion-handoffs/claim
authorization: Bearer PLATFORM_TOKEN
content-type: application/json

{ "code": "one-time-fragment-bearer" }
```

The code is single-use and only the owner who created it can claim it. The public lifecycle is
`waiting`, `claimed`, `completed`, `expired`, or `cancelled`. Owners can read or cancel
`/v1/companion-handoffs/:id`; a controller can read or cancel only its own created handoff under
`/v1/device/companion-handoffs/:id`. Retry creates a fresh code. A claimed phone passes the returned
handoff id into the normal private raw upload session. The gateway then enforces the requested media
kind, pins environment/thread metadata, derives `companion_recording` or `companion_camera`, and
marks the handoff completed after integrity-checked finalization.

Bluetooth earbuds remain a phone/browser input. The PWA lists browser-exposed audio inputs after
permission and can request a selected input; it does not claim that an ESP32-S3 supports Bluetooth
HFP or LE Audio.

## Media upload sessions

Browsers and devices upload short audio clips or still images through a bounded three-step session.
The byte transfer is a private authenticated HTTP request; media bytes are never sent over the
gateway WebSocket/SSE channels and do not become attachable until finalization succeeds.

Device audio sessions require a selected environment and thread. Optional `environmentId` and
`threadId` in the creation body assert the capture destination; mismatches return 409
`capture_target_changed`. That destination is frozen before the byte transfer, and a reused
`clientRequestId` cannot be rebound to another target. Finalize replays reuse the original device
capture job, including a terminal job, preventing duplicate auto-send. A new recording uses a new
request ID even when its bytes match an older clip.


Create an owner session with `POST /v1/media/uploads` and a device session with
`POST /v1/device/media/uploads`. Use the matching platform or device authentication realm:

```http
POST /v1/device/media/uploads
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

```json
{
  "kind": "audio",
  "contentType": "audio/webm",
  "sizeBytes": 1048576,
  "sha256": "64-character-lowercase-hex-digest",
  "clientRequestId": "device-media:stable-request-id",
  "originalName": "prompt.webm",
  "transcript": "Optional transcript from phone, browser, device, or a transcription worker."
}
```

The response contains a redacted session projection and relative private routes:

```json
{
  "session": {
    "id": "mup_...",
    "status": "pending",
    "sizeBytes": 1048576,
    "sha256": "...",
    "expiresAt": "2026-08-27T20:15:00.000Z",
    "upload": {
      "method": "PUT",
      "url": "/v1/device/media/uploads/mup_.../content",
      "contentType": "audio/webm",
      "sizeBytes": 1048576
    },
    "finalizeUrl": "/v1/device/media/uploads/mup_.../finalize",
    "statusUrl": "/v1/device/media/uploads/mup_..."
  }
}
```

Upload the exact raw bytes to `session.upload.url` with the same authentication and declared
`content-type`, then `POST {session.finalizeUrl}`. The gateway verifies the exact length and SHA-256
both before staging and again before committing the media row. Create and finalize are idempotent;
reusing a `clientRequestId` with a different descriptor is `409`. `GET {session.statusUrl}` supports
recovery and `DELETE {session.statusUrl}` aborts and removes staged bytes. Pending/uploaded sessions
expire after `MEDIA_UPLOAD_SESSION_TTL_MS` (15 minutes by default), and the media-retention runner
cleans abandoned private objects. Durable dedup state is capped at 256 sessions per owner; terminal
rows are evicted first and the gateway fails closed rather than discarding unfinished work. Session
responses never expose object keys, original filenames,
transcripts, actor IDs, or client request IDs.

The owner paths have the same suffixes under `/v1/media/uploads`. A browser uses raw XHR so it can
show byte progress and cancel safely. The shared controller core hashes and streams its existing
capture buffer directly, eliminating base64's wire expansion and a second full-size allocation.

The legacy JSON `POST /v1/media` and `POST /v1/device/media` routes remain compatibility paths for
older clients, but new clients should use sessions. Device finalization also enqueues the existing
transcription job and returns `{ session, media, job }`.

Supported content types:

```text
audio/wav
audio/mpeg
audio/mp4
audio/webm
audio/ogg
image/jpeg
image/png
image/webp
```

Finalization returns a `media.id`. Audio uploads may include `transcript`; image uploads ignore it. Media metadata includes `processing.transcriptionStatus`:

```text
pending
processing
ready
failed
unavailable
not_applicable
```

### Media names

Owner-facing media reads (`GET /v1/media`, and the single record returned by `POST /v1/media`,
`PUT /v1/media/:id/transcript`, `POST /v1/media/:id/transcribe`, `DELETE /v1/media/:id`) carry a
derived `displayName` and a structured `origin` alongside the `originalName` the client uploaded:

```json
{
  "id": "media_...",
  "originalName": "controller.wav",
  "displayName": "Hosyond Touch screen · Verify Workspace · 24 Aug 19:32",
  "origin": {
    "source": "controller_capture",
    "deviceId": "dev_...",
    "deviceLabel": "Hosyond Touch screen",
    "environmentId": "env_...",
    "threadId": "thread_voice",
    "threadTitle": "Verify Workspace",
    "capturedAt": "2026-08-24T19:32:05.104Z"
  }
}
```

The label and thread title are computed on read, so a renamed device or a retitled thread is
reflected immediately and clips uploaded before this existed are named too. The non-sensitive
capture-source enum is stored as `controller_capture`, `browser_recording`, `browser_camera`,
`companion_recording`, `companion_camera`, or `upload`; older records retain their legacy
`device`/`console` projection. `originalName` is never
overwritten, and it remains the filename the agent sees on an attachment. Segments are dropped when
unknown: a console upload has no device (`Console · diagram.png · 24 Aug 19:32`), a device with
no bound thread has no destination, and a thread whose title T3 cannot supply is named by a short
form of its id (`Thread 4f2a1c`). See `src/mediaNaming.mjs`.

The Media library fetches image/audio preview bytes only after the owner asks. It uses the normal
authenticated owner route, keeps object URLs in memory only for the mounted row, revokes them on
teardown, uses lazy image decoding and `audio preload="metadata"`, and refuses local previews above
8 MiB for images or 24 MiB for audio. Processing, failure, and retry state remains metadata; user
filenames, descriptions, transcripts, and media bytes are excluded from support projections.

The signed-in owner can update an audio transcript later:

```http
PUT /v1/media/media_.../transcript
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "transcript": "Updated transcript text."
}
```

### Transcription jobs

Transcription is a durable background job, not something the request waits on. Enqueue one:

```http
POST /v1/media/media_.../transcribe
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{}
```

Answers `202` with `{ "job": {...}, "media": {...} }`. The job is picked up by the gateway's media
job worker, which survives a restart: an in-flight job is held by a lease and, once that lease
lapses, any worker may resume it from the evidence already stored. Enqueueing twice while a job is
unfinished returns the same job rather than starting a second one.

If no provider is configured the route still refuses synchronously with `409` and marks the media
`unavailable` — queueing work that would fail identically on every attempt only hides the error.

Stages:

```text
queued -> transcribing -> normalizing -> review_required | ready -> dispatching -> dispatched
                                                                                   failed
```

`dispatched` means the finished transcript has been written onto the media record, which is what an
`audio_prompt` reads. `dispatched` and `failed` are terminal and are never re-claimed.

The job keeps transcript **versions**, not one overwritten string:

| Field | Meaning |
|---|---|
| `rawTranscript` | Exactly what the ASR provider returned, whitespace included. Immutable once written. |
| `normalizedTranscript` | Punctuation and spacing cleanup. Immutable once written. |
| `userEditedTranscript` | The reviewed value, when a person corrected it. Writable. |

Plus `provider`, `model`, `language`, `attempts` / `maxAttempts`, `lastError`, `failureKind`
(`retryable` or `terminal`), `failureCause`, `requeueCount` / `requeuedAt` / `requeuedBy`, a
`timings` map, and the lease fields. The last version present wins: user-edited, else normalized,
else raw.

A retryable failure (timeout, 429, 5xx, unreadable bytes) returns the job to `queued` and costs one
attempt; a terminal one (no provider, missing key, 4xx, empty result) fails immediately rather than
spending the budget on an answer that will not change.

`failureCause` answers the other question — what would have to change for the clip to succeed:

| Cause | Meaning | Examples |
|---|---|---|
| `configuration` | The deployment, not the clip. | No provider selected, missing credential, sidecar not running, English-only checkpoint pointed at another language. |
| `input` | The audio itself. | Container the sidecar does not decode, clip over the length limit, silence. |
| `provider` | Configured and reachable, and still no transcript. | 5xx, timeout, storage having a bad minute. |
| `unknown` | Reached the worker unlabelled. | An unexpected throw. |

It is set where the error is thrown, never inferred from the message text, and it is recorded on
every failure — a retryable failure that later burns the last attempt is failed inside the claim,
which inherits the cause already on the row.

### Retrying a configuration failure

Only an owner can un-terminate a job, and only for a cause a deployment change could have fixed:

```http
POST /v1/media/jobs/retry-configuration
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{ "jobIds": ["mjob_..."] }
```

`jobIds` is optional — omit it to consider every failed job on the account. Answers:

```json
{
  "provider": "openai",
  "holdForReview": true,
  "requeued": [{ "jobId": "mjob_...", "mediaId": "media_...", "attempts": 0, "requeueCount": 1, "previousError": "..." }],
  "skipped": [{ "jobId": "mjob_...", "mediaId": "media_...", "stage": "failed", "failureCause": "input" }],
  "counts": { "requeued": 1, "skipped": 1 }
}
```

- Refused with `409` when no provider is configured, or when the selected one has no credential —
  requeueing into the identical failure would spend the fresh budget reproducing it.
- `404` when a named job id is not one of the caller's.
- Anything that is not a failed job with cause `configuration` is reported in `skipped` with its
  stage and cause, so "I retried and nothing happened" is answerable from the response.
- `attempts` resets to zero: the previous attempts were spent on a fault that no longer exists.
- Nothing runs this on boot, on a poller tick, or after a configuration change. A terminal stage
  promises nothing happens on its own; only a person may break that promise.

**`holdForReview` is not an option.** A requeued job comes back with `reviewRequired` set, so its
transcript parks at `review_required` and waits for a person however the recording device's
auto-send is configured. A transcript is dispatched to a coding agent as an instruction, and the
auto-send grant means "send what I say as I say it" — it was never consent for a batch of captures
from hours or days ago. Once someone accepts the transcript, the ordinary path resumes and the grant
applies again, because now there is a human decision behind the send.

Read jobs:

```http
GET /v1/media/jobs?mediaId=media_...&stage=queued
GET /v1/media/jobs/mjob_...
authorization: Bearer PLATFORM_TOKEN
```

With `TRANSCRIPTION_REVIEW_REQUIRED=1` a finished transcript parks at `review_required` instead of
being applied. Accepting or correcting it records the reviewed version and re-arms dispatch:

```http
POST /v1/media/jobs/mjob_.../transcript
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "transcript": "Deploy the staging branch."
}
```

Refused with `409` unless the job is at `review_required`, `ready` or `dispatched`.

Stage changes are pushed on `/v1/events` as `media.job`, carrying the `milestone` below alongside
the stage so a console and a controller never disagree about where a capture got to. Worker settings:
`TRANSCRIPTION_WORKER_ENABLED`, `TRANSCRIPTION_WORKER_INTERVAL_MS`, `TRANSCRIPTION_BATCH_SIZE`,
`TRANSCRIPTION_LEASE_MS`, `TRANSCRIPTION_MAX_ATTEMPTS`, `TRANSCRIPTION_LANGUAGE`.

Reading a job also returns a computed `transcriptChange`:

```json
{
  "changed": true,
  "contentPreserved": true,
  "rawLength": 56,
  "normalizedLength": 52,
  "firstDivergenceIndex": null
}
```

Cleanup may move spacing, punctuation and case and nothing else. `contentPreserved` compares the
letters and digits of the two versions with everything else stripped out; when it is `false`
something rewrote what the speaker said, so the job parks at `review_required` whatever
`TRANSCRIPTION_REVIEW_REQUIRED` says and the change is shown as a diff rather than dispatched as a
command. `rawTranscript` is kept verbatim either way.

### The parakeet sidecar

`TRANSCRIPTION_PROVIDER=parakeet` talks to a small local ASR service running
`nvidia/parakeet-tdt-0.6b-v2`. The gateway never imports Python and never blocks its event loop on
inference: it POSTs the clip over HTTP and waits on a socket, exactly as it does for a hosted API.
CPU inference is the supported default and a GPU is only an accelerator, which is why the timeout
defaults to minutes and concurrency to one.

**Where it runs in production, decided 2026-09-09: an operator-managed service beside the Container,
not a connector capability.** Both were open options in the cloud roadmap's §21. The sidecar carries
roughly 630 MB of ONNX weights and wants a long-lived process with real CPU, which is the opposite
of what the connector is: a small, dependency-free CLI a user installs with one `npx` command on
their own laptop, and which must stay cheap enough to leave running. Putting inference there would
make every user's machine a transcription host, and would make the connector's install size and CPU
profile a support problem.

Three consequences for deployment, and none needs new code:

- The gateway reaches the sidecar over plain HTTP at `PARAKEET_URL`, so the service must sit on a
  private network the Container can route to, never on the public internet. It has no authentication
  of its own; network reachability is the entire boundary.
- The weights are an operator artifact, fetched once with `npm run parakeet:fetch` and mounted or
  baked into whatever runs the sidecar. They are deliberately not in the Container image, which is
  budgeted at roughly 78 MB compressed.
- `TRANSCRIPTION_PROVIDER` unset means `disabled`, and a disabled provider fails every job
  terminally. A deployment that forgets to name a provider has an inert voice pipeline that looks
  configured, so completion plan item 4.6b treats naming and reaching the provider as its first
  check.

A hosted transcription API remains a drop-in alternative: the adapter boundary is the same, and only
`TRANSCRIPTION_PROVIDER` and its credential change.

| Variable | Default | Meaning |
|---|---|---|
| `PARAKEET_URL` | `http://127.0.0.1:8977/v1/transcribe` | The sidecar endpoint. |
| `PARAKEET_MODEL` | `nvidia/parakeet-tdt-0.6b-v2` | Checkpoint the sidecar should load. |
| `PARAKEET_API_KEY` | unset | Only needed when the sidecar sits behind an authenticated hop. |
| `PARAKEET_TIMEOUT_MS` | `120000` | A long clip on CPU takes far more than a hosted API would. |
| `PARAKEET_MAX_CLIP_SECONDS` | `120` | Clip ceiling; inference cost scales with audio length. |
| `PARAKEET_LANGUAGE` | `PARAKEET_LANGUAGE` → `TRANSCRIPTION_LANGUAGE` → `en` | Declared on every request, never detected. |
| `PARAKEET_CONCURRENCY` | `1` | How many clips may be inside the sidecar at once. |
| `PARAKEET_ACCEPTED_CONTENT_TYPES` | `audio/wav,audio/webm,audio/ogg,audio/mp4` | Containers the sidecar's decoder can open. |
| `PARAKEET_MODEL_DIR` | `.data/models/parakeet-tdt-0.6b-v2-onnx` | Read by the fetch script and the sidecar, not by the gateway. |
| `PARAKEET_MODEL_PRECISION` | `int8` | `int8` (~630 MB) or `fp32` (~2.5 GB). Sidecar-side only. |

**Running it.** The sidecar ships in this repo as `scripts/parakeet-sidecar.py`, and the weights are
fetched by `scripts/fetch-parakeet-model.mjs`:

```bash
uv venv --python 3.12 .venv-parakeet
uv pip install --python .venv-parakeet/bin/python onnx-asr onnxruntime
npm run parakeet:fetch          # ~630 MB into PARAKEET_MODEL_DIR, digest-verified, resumable
npm run parakeet:sidecar        # loads the model, then listens on 127.0.0.1:8977
```

Then set `TRANSCRIPTION_PROVIDER=parakeet` and restart the gateway. `GET /healthz` on the sidecar
reports the loaded checkpoint, precision and model directory; `npm run parakeet:fetch -- --check`
re-verifies the weights on disk without downloading anything.

The runtime is **onnxruntime via onnx-asr, not nemo_toolkit**. NVIDIA publishes the checkpoint as a
2.4 GB `.nemo` archive only NeMo can open, and NeMo pulls in PyTorch, Lightning and Hydra to run
600M parameters of CPU inference; `istupakov/parakeet-tdt-0.6b-v2-onnx` is that same checkpoint
exported to ONNX, and its int8 export runs under onnxruntime with numpy as the only other
dependency. Measured on an M-series CPU Mac, a 4.6 s clip transcribes in ~1.2 s — a `realtimeFactor`
around `0.26`.

The download is CC-BY-4.0 and ungated, so no Hugging Face token is involved. **The weights are never
committed**: they live under `.data/`, and the sidecar's virtualenv under `.venv-parakeet/`, both
gitignored.

**Containers.** Browser capture arrives as WebM/Opus (Chrome, Firefox) or MP4/AAC (Safari); a
controller uploads 16 kHz mono WAV, which needs no decoding at all. Anything outside the accepted
list is refused by the adapter, with the list in the message, rather than posted and returned as an
opaque 4xx. A WAV's length is read from its own header, so an over-long clip is refused before any
inference is paid for; a compressed container's length is enforced by the sidecar, which is why
`max_clip_seconds` is sent with every request.

**Language.** v2 is an English model. Pointing it at another language does not produce that
language, it produces confident English-shaped nonsense — so a language the configured checkpoint
cannot speak is refused as the configuration error it is. Another language means a different
`PARAKEET_MODEL`, not this one trying harder.

**The request** is `multipart/form-data` with `model`, `language`, `max_clip_seconds`, the `file`,
and `sample_rate` / `channels` when they are already known from a WAV header. A successful response
is JSON:

```json
{
  "text": "Deploy the staging branch.",
  "model": "nvidia/parakeet-tdt-0.6b-v2",
  "language": "en",
  "duration_seconds": 4.0,
  "timings": { "decode_ms": 24, "inference_ms": 2000 }
}
```

`camelCase` and `snake_case` keys are both read. A non-2xx quotes the sidecar's own `error`,
`detail` or `message` back in `lastError`; `408`, `425`, `429` and `5xx` are retryable, everything
else is terminal. A timeout or an unreachable sidecar is retryable, because a restart looks
identical to an outage.

**Timings.** A finished job's `timings` map carries `queueWaitMs` (row queued to worker pickup),
`gateWaitMs` (waiting for a sidecar slot), `decodeMs` and `inferenceMs` (reported by the sidecar),
`providerMs` (the round trip), `normalizeMs`, and `totalMs`. When the sidecar reports the clip
length, `realtimeFactor` is seconds of compute per second of audio — above `1.0` the box cannot
keep up with speech in real time, which is the number that decides whether a GPU is worth adding.

The audio itself is never consumed: a transcript is a derived artefact and `GET /v1/media/media_...`
keeps returning the original bytes for as long as retention allows.

Reference the `media.id` from an audio or camera prompt:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "camera_prompt",
    "mediaUploadIds": ["media_...", "media_..."],
    "prompt": "Use these images as context for the current task."
  }
}
```

`mediaUploadIds` is an ordered list and the agent receives the attachments in that order. A single
`mediaUploadId` stays accepted as an alias for a one-item list, which is what protocol-v1 firmware
sends. Every id must belong to the caller (404 otherwise), every referenced upload must be a
supported kind (415 otherwise), and at most 8 may be attached to one turn (400 otherwise).

For `audio_prompt`, the gateway uses `intent.transcript` first. If it is omitted, the gateway uses the stored transcript on the referenced audio media. If no transcript is ready yet, the prompt is dispatched as media context so the command remains auditable.

User clients can list and retrieve media:

```http
GET /v1/media
authorization: Bearer PLATFORM_TOKEN
```

```http
GET /v1/media/media_...
authorization: Bearer PLATFORM_TOKEN
```

```http
DELETE /v1/media/media_...
authorization: Bearer PLATFORM_TOKEN
```

Deleting media removes the stored file bytes and hides the upload from future media lists. Existing command audit records keep redacted metadata only.

Media responses include `expiresAt`. New uploads use the user's privacy retention setting. `expiresAt: null` means the capture is kept until manual deletion.

### The device voice loop

Audio uploaded by a device is queued for transcription automatically — nothing has to ask for it.
The response carries the one identifier the controller needs:

```json
{
  "media": { "id": "media_...", "kind": "audio", "processing": { "transcriptionStatus": "processing" } },
  "job": {
    "jobId": "mjob_...",
    "mediaId": "media_...",
    "milestone": "transcribing",
    "label": "Transcribing",
    "done": false,
    "ok": true,
    "transcript": null,
    "autoSend": false,
    "commandId": null,
    "updatedAt": "2026-02-01T10:15:00.000Z"
  }
}
```

`job` is `null` when the upload was an image, or when no transcription provider is configured — the
upload still succeeds and the media is marked `unavailable`. The capture pins the `environmentId`
and `threadId` the controller was pointed at (from the body, else from the device config), so a
delayed transcript reaches the thread the owner was talking to rather than whichever one is
selected by the time the worker runs.

Poll one endpoint:

```http
GET /v1/device/media/jobs/mjob_...
x-device-id: dev_...
x-device-secret: ...
```

Answers `404` unless the job was recorded by *this* device. Two controllers on one account are two
microphones in two rooms, and the transcript is in the response.

The reply is the projection above and nothing else — stages, leases, attempt counts, provider names
and timings stay on the owner-facing `/v1/media/jobs/:id`. Milestones:

| Milestone | Meaning |
|---|---|
| `recorded` | Device-local. Capture finished, upload not started. |
| `uploading` | Device-local. Bytes in flight. |
| `transcribing` | Queued or being transcribed. |
| `review` | Waiting on a person: review was configured, cleanup altered the wording, or policy asked for approval. |
| `ready` | Transcript is on the media record and waiting. Auto-send is off. |
| `sent` | Dispatched to the agent; `commandId` names the command. |
| `failed` | Transcription failed, or the send was refused. `error` says which. |

`done` is true for every milestone that stops the polling; `ok` is false only for `failed`.

### Auto-send

Auto-send has **three** states, not two, and only two of them are decisions:

```http
PUT /v1/devices/dev_.../voice-auto-send
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{ "enabled": true }
```

`enabled` accepts `true`, `false`, or `null` — `null` withdraws the owner's decision and hands the
device back to its default. Omitting the field is a `400`: an absent value is a malformed request,
not a third state expressed by silence.

Answers `{ "device": {...}, "voiceAutoSend": { ... } }`, and `GET` on the same path reads it:

| Field | Meaning |
|---|---|
| `ownerChoice` | The owner's decision: `true`, `false`, or `null` for "never said". |
| `enabled` | The effective answer. An explicit `ownerChoice` wins; otherwise the hardware decides. |
| `source` | `owner` when a decision exists, `default` otherwise. |
| `audioCapable` | Whether this device has declared `microphone` in `status.features` on a heartbeat. |
| `enabledBy` / `enabledAt` | Who granted it explicitly, and when. Both stay `null` for a default. |

**The default is on for a controller that has reported a microphone**, and off for one that has not.
A device whose purpose is to be spoken to should work when it is spoken to; a board that never
claimed a microphone is never handed a licence it could not use. The capability is read from what
the firmware declared on a heartbeat, not from what the hardware model is supposed to have.

An owner's explicit choice beats the default in both directions and is never undone by one: a
firmware update that re-declares the microphone, a restart, or a re-claim all leave `ownerChoice`
alone. That is why the third state exists — with a plain boolean, "off" could not be told from
"nobody has said", and the default would keep switching it back on. `enabledBy`/`enabledAt` are
reserved for a real grant, so a default is never recorded as though somebody signed for it.

There is deliberately no account-wide switch: auto-send is a trust decision about one microphone in
one room, and a controller claimed later earns its own answer from its own hardware.

Owner realm only — a device cannot widen its own licence to act on what it hears.

The grant, the device, and the **policy** are all read at the moment of dispatch, never at enqueue.
A capture that sat in the queue while the owner tightened the device profile, revoked the device, or
turned auto-send back off is judged by the newer rules. When auto-send is on, the transcript goes
out through the ordinary device intent path (`normalizeIntent` → `evaluateIntentPolicy` →
`thread.turn.start`) with the recording attached, producing a normal command on the timeline
credited to the device that recorded it.

A refusal is not a transcription failure. The transcript is written to the media record either way;
only the send is declined, and the job records that separately:

| Field | Meaning |
|---|---|
| `dispatchStatus` | `null` (never attempted), `sent`, `approval_required`, `blocked` (policy), `failed`. |
| `dispatchError` | Why the send did not go. Distinct from `lastError`, which is why transcription did not. |
| `commandId` | The command the transcript became, when one was created. |
| `autoSend` | The decision the worker actually acted on. |

## Privacy Settings

```http
GET /v1/settings/privacy
authorization: Bearer PLATFORM_TOKEN
```

```json
{
  "privacy": {
    "mediaRetentionDays": 30
  }
}
```

```http
PUT /v1/settings/privacy
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "mediaRetentionDays": 7
}
```

Use `null` for manual deletion only:

```json
{
  "mediaRetentionDays": null
}
```

## T3 Code Compatibility

Read the current supported-release policy and the latest saved compatibility result for every
paired T3 environment:

```http
GET /v1/settings/t3-compatibility
authorization: Bearer PLATFORM_TOKEN
```

Run a fresh, read-only check against every paired environment:

```http
POST /v1/settings/t3-compatibility
authorization: Bearer PLATFORM_TOKEN
content-type: application/json

{}
```

Pass `environmentId` to check one environment. The gateway reads
`/.well-known/t3/environment`, validates the orchestration snapshot contract, compares the
reported server version with the latest `t3` package release, and persists the result in
environment health. A later check records `versionChanged` and raises `breakingRisk` when a
changed version is outside the certified range or a required read-only contract fails.

The response includes the installed, latest, minimum-supported, maximum-tested, and recommended
versions; individual contract checks; compatibility findings; and a fleet summary. Compatibility
results also feed `/v1/observability/alerts` so potentially breaking T3 changes appear as critical
environment alerts.

Purge expired media bytes and metadata:

```http
POST /v1/media/purge-expired
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

## Register T3 Environment

The guided host setup is available through `npm run setup:t3`. Adding an initial project is optional; users can instead manage projects directly in T3 Code or with `t3 project`.

Launch the first thread for a project that is already registered in T3:

```http
POST /v1/t3/environments/:environmentId/threads
Authorization: Bearer PLATFORM_TOKEN
Content-Type: application/json

{
  "projectId": "project_id",
  "text": "Inspect this project and report that the session is ready.",
  "modelSelection": {
    "instanceId": "codex",
    "model": "gpt-5.4"
  },
  "runtimeMode": "approval-required",
  "interactionMode": "default",
  "mediaUploadIds": ["media_id"]
}
```

`mediaUploadIds` (or a single `mediaUploadId`) attaches already-uploaded media to the first turn, on the same terms as `POST /v1/intents`: every id must belong to the caller (404 otherwise), and at most 8 may be attached (400 otherwise).

`modelSelection` is optional when the T3 project has a default. Provider instance IDs are not restricted to built-ins, so user-defined T3 provider instances are supported. The gateway dispatches `thread.create` followed by `thread.turn.start` because T3's HTTP orchestration endpoint requires the thread to exist before accepting the first turn.

### Manage a T3 thread

Platform users can manage threads in an environment they own. These routes forward T3's native
orchestration commands; the gateway does not keep a second copy of thread metadata.

```http
PATCH  /v1/t3/environments/:environmentId/threads/:threadId
POST   /v1/t3/environments/:environmentId/threads/:threadId/archive
DELETE /v1/t3/environments/:environmentId/threads/:threadId
Authorization: Bearer <platform-token>
Content-Type: application/json
```

Rename body:

```json
{ "title": "Release checklist" }
```

Rename collapses whitespace and caps the title to T3's supported length. Archive is recoverable
from T3 Code; delete permanently removes the thread and its conversation. Successful mutations
return `202` with `environmentId`, `threadId`, `action`, and T3's dispatch `result`; rename also
returns the normalized `title` applied to T3.

### Console-first pairing (connect sessions)

Connect sessions let the console mint a short-lived, single-use enrollment code while the user is
signed in, show one command to run on the host, and poll until the connector lands. The cloud never
receives the local T3 URL, pairing token, or access token.

```http
POST /v1/t3/connect-sessions
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "Mac T3 Code",
  "accessMode": "tailscale",
  "environmentId": "env_..."
}
```

`accessMode` is retained as connection-session metadata for compatibility; it does not alter the
connector command or disclose a T3 credential. `environmentId` is optional and marks the session as
a **re-pair**: connector enrollment updates that environment in place rather than creating a row. A
first pairing is checked against the plan's environment allowance; a re-pair is not.

The response carries the code once — the gateway stores only its SHA-256 hash and cannot show it
again:

```json
{
  "session": { "id": "cxn_...", "status": "pending", "expiresAt": "..." },
  "code": "ABCDE-FGHIJ",
  "gatewayUrl": "https://gateway.example",
  "command": "npx @next-coder/connector connect --server 'https://gateway.example' --code 'ABCDE-FGHIJ'"
}
```

Poll while the user is on the other machine:

```http
GET /v1/t3/connect-sessions/cxn_...
authorization: Bearer PLATFORM_TOKEN
```

Returns `{ "session": ..., "environment": ... }`. `session.status` is `pending`, `redeeming`,
`completed`, `failed`, or `expired`; `environment` is populated only once the status is `completed`.
A session belonging to another user answers 404.

The connector redeems the code without a platform credential:

```http
POST /v1/connectors/enroll
content-type: application/json
```

```json
{
  "code": "ABCDE-FGHIJ",
  "protocolVersion": 1,
  "connectorVersion": "0.1.0",
  "platform": "darwin-arm64",
  "capabilities": ["snapshot", "dispatch"]
}
```

The response returns a connector-mode environment, connector metadata, and the standing connector
secret once. The environment has no `baseUrl` or T3 access token. Supplying `accessToken` or
`pairingToken` returns 400 before consuming the code.

### Atomic connector credential rotation

An authenticated owner first creates a rotation session. This is a separate user-realm endpoint so
platform and connector credentials are never interchangeable:

```http
POST /v1/connectors/ctr_.../rotation-sessions
authorization: Bearer PLATFORM_TOKEN
```

It returns a 15-minute single-use code and canonical `npx ... rotate --server ... --code ... --yes`
command. The connector then authenticates with its current standing credential and stages a new one
without changing connector or environment identity:

The code is purpose-bound to `connector_rotation`. A T3 enrollment/re-pair code cannot authorize
this endpoint, and a rotation code cannot be redeemed by connector-enrollment or legacy T3 setup.

```http
POST /v1/connectors/ctr_.../rotate
authorization: Connector ctr_....CURRENT_SECRET
content-type: application/json
```

```json
{ "code": "ABCDE-FGHIJ" }
```

The `201` response returns `{ connector, rotation: { id, expiresAt }, secret }`; the staged secret is
shown once and its hash is retained for no more than ten minutes. During that bounded overlap the
current credential and live socket remain valid. The staged credential may mint a short-lived socket
ticket. Atomically consuming the first such ticket is the acknowledgement and commit point: its hash
becomes current, unconsumed tickets from the old generation are retired, and the old standing secret
can no longer mint tickets. The environment Durable Object accepts only one authoritative socket, so
the newly authenticated bridge supersedes the prior socket before the managed service takes over.

The CLI persists a private local journal before activation (native credential storage when available,
otherwise a mode-`0600` file). Runtime health and cursor writes use a separate private sidecar, so a
stale managed process cannot erase that journal during handoff. `rotate --yes` resumes an interrupted
attempt without a new code; supplying a new code replaces an uncommitted attempt. Owner revocation
still clears both active and staged hashes and closes the live socket immediately. Neither secret is
included in audit metadata, connector events, or public connector projections.

### Connector self-revocation

The CLI can revoke its own standing authority without a platform bearer:

```http
POST /v1/connectors/self/revoke
authorization: Connector ctr_....CURRENT_SECRET
content-type: application/json
```

The gateway rate-limits this as `connector:write`, consumes every outstanding ticket, persists the
connector as revoked, and asks the environment router to close matching sockets, subscriptions,
leases, and pending requests. A `200` response returns `{ "connector": ... }` with status `revoked`.
If edge closure fails, the route returns an error after durable revocation; the exact same current
credential may retry only this self-revocation operation. Ordinary authentication and ticket minting
reject it. The server retains only its one-way hash for that retry and never returns or audits the
secret. The CLI does not remove local credentials until this route succeeds unless the operator
explicitly uses `--force-local`.

### Legacy direct redeem (self-hosted only)

The repository-local `setup:t3` compatibility path can redeem an enrollment-purpose code against a
**self-hosted** gateway. This route takes no platform credential—the code is the credential—and is
rate limited per client address (`CONNECT_REDEEM_RATE_LIMIT`, default 20/window):

```http
POST /v1/t3/connect-sessions/redeem
content-type: application/json
```

```json
{
  "code": "ABCDE-FGHIJ",
  "baseUrl": "https://mac.tailnet.ts.net",
  "pairingToken": "...",
  "instances": [{ "instanceId": "anthropic", "status": "ready", "models": [] }]
}
```

`instances` is the provider catalogue read from `<base-dir>/caches/*.json`; it rides along because
the script has no platform token to `PUT /v1/t3/environments/:id/catalogue` with. `accessToken` may
replace `pairingToken` for local development. On success the gateway exchanges the token, upserts the
environment, registers the catalogue, health-checks the host, and returns
`{ session, environment, screen, failure, catalogue }` with HTTP 201.

A code is single use and lives 15 minutes. A replayed or unknown code returns 404; an expired one
returns 410 so the host can tell the user to mint a fresh code rather than hunt for a typo. Request
validation happens **before** the code is consumed, so a malformed body leaves the code usable. If
the exchange itself fails, the session is marked `failed` with the reason, which is what the polling
console renders.

With `DEPLOYMENT_MODE=cloud`, this legacy route returns 404 after its client-address rate limit but
before parsing the body, consuming the code, exchanging a pairing token, or making an outbound
request. The code therefore remains usable at `/v1/connectors/enroll`.

`scripts/setup-t3.mjs` drives this with `--connect-code`; `--gateway-token` / `--gateway-dev-user`
remain for the manual path. Launching a first thread (`--initial-prompt`) still needs a platform
token, because a connect code deliberately does not grant the platform realm.

### Manual pairing (self-hosted only)

```http
POST /v1/t3/environments
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "Mac T3 Code",
  "baseUrl": "https://mac.tailnet.ts.net",
  "pairingToken": "..."
}
```

Development can provide an existing T3 access token:

```json
{
  "label": "Mac T3 Code",
  "baseUrl": "https://mac.tailnet.ts.net",
  "accessToken": "...",
  "accessTokenExpiresAt": "2026-06-16T19:00:00.000Z"
}
```

This compatibility route is disabled when `DEPLOYMENT_MODE=cloud`: an authenticated request returns
409 before its body can trigger token exchange or environment storage. Self-hosted gateways encrypt
stored T3 access tokens when `T3_TOKEN_ENCRYPTION_KEY` is configured. Convex-backed self-hosted
deployments fall back to `GATEWAY_CONVEX_SECRET` if no dedicated token encryption key is set.

When T3 token exchange returns `expires_in`, the gateway stores an `accessTokenExpiresAt` timestamp automatically. Manual access-token registration can include `accessTokenExpiresAt`; omitted means the gateway has no known expiry for that token. Expired T3 credentials set environment health to `token_expired` and return HTTP 409 for snapshot, dispatch, and approval dispatch until the environment is re-paired or updated.

Read the owner-scoped, versioned capability manifest:

```http
GET /v1/t3/environments/env_.../capabilities
authorization: Bearer PLATFORM_TOKEN
```

Add `?refresh=1` for a fresh bounded probe. The response carries
`manifest.schema: "next-coder.t3-capabilities.v1"`, the adapter contract, installed version,
probe/freshness/source metadata, separately gated feature and attachment states, runtime/interaction
modes, approval decisions, and a bounded recovery action. The legacy `capabilities` booleans remain
as a compatibility projection of that manifest; they are no longer inferred from scopes alone.
Fresh results are cached for five minutes. The owner projection contains no paths, provider config,
project/thread identifiers, prompts, transcripts, or credentials. See
[t3-capability-manifest.md](t3-capability-manifest.md).

Update a paired environment:

```http
PUT /v1/t3/environments/env_...
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "MacBook Pro T3 Code",
  "baseUrl": "https://macbook.tailnet.ts.net",
  "accessToken": "...",
  "accessTokenExpiresAt": "2026-06-16T19:00:00.000Z"
}
```

On a self-hosted gateway, you can also send a new `pairingToken` instead of `accessToken`. Omitted
fields keep their current values, including `accessTokenExpiresAt`.

In cloud mode, `PUT` only accepts `{ "label": "..." }` for a connector-backed environment. Fields
that could change routing, credentials, capability, or transport—including `baseUrl`, `accessToken`,
`accessTokenExpiresAt`, `pairingToken`, `scopes`, and `transportMode`—return 409. A persisted legacy
direct environment cannot be edited or contacted: the transport boundary rejects it before network
I/O (individual operation routes retain their established error envelope).

Preview what still points at an environment before archiving or deleting it:

```http
GET /v1/t3/environments/env_.../dependencies
authorization: Bearer PLATFORM_TOKEN
```

```json
{
  "environmentId": "env_...",
  "dependencies": {
    "devices": [{ "id": "dev_...", "label": "Desk Controller" }],
    "actions": [{ "id": "action_...", "label": "Ship it" }],
    "macros": [],
    "onboarding": true
  },
  "counts": { "devices": 1, "actions": 1, "macros": 0, "onboarding": 1 }
}
```

Archive and fully disconnect an environment while retaining its dashboard record:

```http
POST /v1/t3/environments/env_.../archive
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

The response includes the archived environment, the same `removed` dependency summary shown below,
and `alreadyArchived`. Archiving deletes the stored T3 credential, stops polling, clears device and
onboarding selections, disables fixed actions and macros, and excludes the record from every device
environment list. `GET /v1/t3/environments` still includes the row with `status: "archived"` and an
`archivedAt` timestamp so the dashboard can render its Archive section. Repeating the request is
idempotent.

Remove a connected environment into retention:

```http
DELETE /v1/t3/environments/env_...
authorization: Bearer PLATFORM_TOKEN
content-type: application/json

{ "confirmationLabel": "MacBook Pro T3 Code" }
```

```json
{
  "environment": { "id": "env_...", "label": "MacBook Pro T3 Code" },
  "removed": {
    "devices": ["dev_..."],
    "actions": ["action_..."],
    "macros": ["macro_..."],
    "onboarding": true
  },
  "alreadyRemoved": false
}
```

Removal immediately revokes the connector and stored T3 credential and repairs everything that
referenced the environment: device runtime configs lose it as their default, the onboarding
selection (and its first thread) is cleared, and saved actions and macros that targeted it are
**disabled** with `disabledReason: "environment_removed"` rather than left dangling. When the
dependency preview is non-empty, `confirmationLabel` must exactly match the environment's current
label or the gateway returns `409 environment_label_confirmation_required`.

The returned credential-free tombstone includes `deletedAt` and `purgeAfter`; its default recovery
window is configured with `ENVIRONMENT_RETENTION_DAYS` (30 days). Repeating removal is idempotent
and returns the same tombstone with an empty `removed` summary. Restore during the window with:

```http
POST /v1/t3/environments/env_.../restore
authorization: Bearer PLATFORM_TOKEN
```

Restore is idempotent and returns the record in `needs_repair`: revoked credentials, connector
sessions, device defaults, actions, macros, and onboarding selections are never silently recreated.
The owner must re-pair and intentionally repair targets. `410 environment_retention_expired` means
the recovery deadline passed. The user-scoped `environment.retention` background task performs
explicit purge after that deadline. Purge removes only the tombstone; command/audit history remains
under its own retention, and media remains governed by the user's media-retention policy. Audit
records include ids, labels, retention deadlines, and repair counts, never credentials or T3 URLs.

Check whether a paired environment is currently reachable:

```http
POST /v1/t3/environments/env_.../check
authorization: Bearer PLATFORM_TOKEN
```

The gateway calls `/api/orchestration/snapshot` with a timeout and stores compact health on the environment:

```json
{
  "environment": {
    "id": "env_...",
    "status": "reachable",
    "health": {
      "lastCheckedAt": "2026-06-14T23:20:00.000Z",
      "lastReachableAt": "2026-06-14T23:20:00.000Z",
      "lastError": null,
      "snapshot": {
        "title": "T3 Code",
        "state": "reachable",
        "line1": "2 projects",
        "line2": "1 threads"
      }
    }
  }
}
```

Fetch the full T3 snapshot for project/thread selection:

```http
GET /v1/t3/environments/env_.../snapshot
authorization: Bearer PLATFORM_TOKEN
```

The response includes the raw T3 snapshot plus the compact screen summary. The gateway also refreshes the environment health fields:

```json
{
  "environment": {
    "id": "env_...",
    "status": "reachable"
  },
  "snapshot": {
    "projects": [{ "id": "project_...", "title": "Next Coder" }],
    "threads": [{ "id": "thread_...", "title": "Implementation" }]
  },
  "screen": {
    "title": "T3 Code",
    "state": "reachable",
    "line1": "1 projects",
    "line2": "1 threads"
  }
}
```

## Firmware Releases

Publish firmware metadata:

```http
POST /v1/factory/firmware/releases
authorization: Bearer FACTORY_TOKEN
content-type: application/json
```

```json
{
  "version": "0.2.0",
  "hardwareModel": "e213-esp32-s3r8",
  "url": "https://cdn.example.com/firmware/next-coder-0.2.0.bin",
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sizeBytes": 901385,
  "mandatory": false,
  "releaseNotes": "Adds runtime config polling."
}
```

The response includes a signed manifest. The signature is an HMAC-SHA256 over canonical manifest fields using `OTA_SIGNING_KEY`.

List firmware releases:

```http
GET /v1/factory/firmware/releases?hardwareModel=e213-esp32-s3r8
authorization: Bearer FACTORY_TOKEN
```

Remove a withdrawn or temporary release so devices cannot keep retrying an unavailable artifact:

```http
DELETE /v1/factory/firmware/releases/fw_...
authorization: Bearer FACTORY_TOKEN
```

Owners can read the public release catalogue needed to build a rollout without receiving artifact
storage keys or signing material:

```http
GET /v1/firmware/releases?channel=stable
authorization: Bearer PLATFORM_TOKEN
```

## Release Rollout Controls

Create an owner-scoped draft. `cohort` is either a stable percentage or an explicit allowlist of
owned, active target ids. Firmware drafts require an existing signed `releaseId`; connector drafts
use the package version and remain locally installed.

```http
POST /v1/release-rollouts
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "name": "Internal controller canary",
  "targetKind": "firmware",
  "targetVersion": "0.2.0",
  "rollbackVersion": "0.1.9",
  "releaseId": "fw_...",
  "channel": "stable",
  "cohort": { "type": "percentage", "percentage": 10 },
  "minimumProtocolVersion": 2,
  "requiredCapabilities": ["ota_confirm"]
}
```

List summaries or inspect bounded per-target progress:

```http
GET /v1/release-rollouts
GET /v1/release-rollouts/rol_...
authorization: Bearer PLATFORM_TOKEN
```

Change state only with an operator evidence identifier:

```http
POST /v1/release-rollouts/rol_.../actions
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{ "action": "start", "evidenceRef": "test-run:staging-2026-08-27" }
```

Actions are `start`, `pause`, `resume`, `expand`, `cancel`, `rollback`, and `complete`. `expand`
also supplies a larger integer `percentage`. The service never advances percentage or terminal
state based on time alone. `complete` returns `409` until every assignment reports the expected
terminal version. Connector assignments report `connector_update_requires_local_cli` until the
connector independently reports the target version. See [release-rollouts.md](release-rollouts.md)
for the state machine and incident procedure.

## Device Intent

```http
POST /v1/device/intents
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

Prompt:

```json
{
  "clientRequestId": "dev:84d1f1d2-88984f43-a15b19c0-9238f411",
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "agent_prompt",
    "text": "Continue the implementation and run tests."
  }
}
```

Status:

```json
{
  "clientRequestId": "dev:991fd3c2-9248c000-97ce21ae-fbad0091",
  "environmentId": "env_...",
  "intent": {
    "type": "status"
  }
}
```

Audio transcript:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "audio_prompt",
    "transcript": "Check the current implementation and continue."
  }
}
```

Audio prompt using a stored media transcript:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "audio_prompt",
    "mediaUploadIds": ["media_..."]
  }
}
```

Camera prompt:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "camera_prompt",
    "mediaUploadIds": ["media_..."],
    "prompt": "Use this image as context for the current coding task."
  }
}
```

Shell input:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "shell_input",
    "command": "npm test"
  }
}
```

Shell input is converted into an approval-required agent prompt. High-risk shell input, such as destructive file operations, is stored as an `approval_required` command and must be approved by a signed-in user before dispatch.

Direct terminal write is a separate `terminal_input` intent (`{"type": "terminal_input", "terminalId": "…", "data": "…"}`, optional `cwd`, at most 65,536 characters). It is deliberately hard to reach: no built-in device profile grants the `terminal_input` capability, the environment must have been paired with the `terminal:operate` scope, which standard pairing does not request, and `baseline.terminal-input` returns `requiresApproval` regardless of which policy dimension allowed it, because a raw terminal write cannot be pattern-screened. Approved writes are dispatched over the T3 WebSocket (`terminal.open` then `terminal.write`), not through orchestration dispatch.

## Command Approvals

List commands, including pending approvals:

```http
GET /v1/commands
authorization: Bearer PLATFORM_TOKEN
```

Inspect a command's status timeline:

```http
GET /v1/commands/cmd_.../events
authorization: Bearer PLATFORM_TOKEN
```

The timeline records command creation and status transitions such as `approval_required`, `blocked`, `dispatched`, `failed`, and `rejected`, including actor type, previous status, risk, result metadata, and command metrics.

Command responses include a `metrics` object:

```json
{
  "acknowledgementDurationMs": 148,
  "dispatchDurationMs": 93,
  "dispatchStartedAt": "2026-06-16T18:59:59.907Z",
  "completedAt": "2026-06-16T19:00:00.000Z",
  "failureAt": null
}
```

`dispatchStartedAt` is present when dispatch began. It remains stable when completion metrics
change, and anchors reply freshness even if the agent replies before its acknowledgement arrives.

If T3 dispatch or status snapshot retrieval fails, the gateway stores a command with status `failed`, returns HTTP 502, and includes the failed command in the error details. This gives support and dashboards a durable record of failed dispatches instead of losing them as transient request errors.

Approve a pending command:

```http
POST /v1/commands/cmd_.../approve
authorization: Bearer PLATFORM_TOKEN
```

Reject a pending command:

```http
POST /v1/commands/cmd_.../reject
authorization: Bearer PLATFORM_TOKEN
```

Only commands with status `approval_required` can be approved or rejected. Approving dispatches the stored normalized intent to the paired T3 Code environment; rejecting records the decision without dispatching to T3.

## Provider Approvals

**A different question from the one above.** `/v1/commands/:id/approve|reject` answers a *gateway*
hold: policy refused to dispatch something you asked for, and the gateway is holding it. A provider
approval is the opposite direction — a turn is already running inside T3 and the agent has stopped
mid-turn to ask permission ("Claude wants to edit `src/app.mjs`"). It is a live callback inside T3,
not a gateway record: it expires with the session, and the gateway cannot extend it.

The two never share a list. Provider approvals have their own routes, their own id space (T3's
`requestId`, not a gateway command id), and their own four-valued decision set.

### The decisions

T3's `ProviderApprovalDecision` (`packages/contracts/src/orchestration.ts`, T3 Code 0.0.32):

| decision | meaning |
|---|---|
| `accept` | Allow once. The agent asks again next time. |
| `acceptForSession` | Allow always, for this session — the provider records a standing permission rule. |
| `decline` | Refuse this request. The agent is told and keeps working. |
| `cancel` | Refuse and stop what the agent was doing. |

`approve` and `reject` are accepted as aliases for `accept` and `decline` so firmware in the field
keeps working; they are canonicalised before anything is recorded or dispatched.

`acceptForSession` is gated by its own capability, `approval_response_persistent`. Of the built-in
profiles only `power-controller` (the console) carries it: a standing grant made by tapping a button
on a 240x320 panel, where the request detail is clipped to a line and a half, is not the same act as
making it in the console with the request in full on screen.

### List

```http
GET /v1/t3/environments/env_.../threads/thread_.../approvals
authorization: Bearer PLATFORM_TOKEN
```

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "approvals": [
    {
      "kind": "provider",
      "requestId": "req_...",
      "threadId": "thread_...",
      "requestKind": "file-change",
      "requestType": "file_change_approval",
      "detail": "src/app.mjs",
      "summary": "File-change approval requested",
      "status": "pending",
      "decision": null,
      "failure": null,
      "localDecision": null
    }
  ],
  "decisions": [{ "decision": "accept", "label": "Allow once", "persistent": false, "allows": true }],
  "allowedDecisions": ["accept", "acceptForSession", "decline", "cancel"]
}
```

`status` is `pending`, `resolved` (T3 recorded a decision), or `stale` (T3 abandoned the request —
the provider callback did not survive a restart or a recovered session, and no answer can revive
it). `localDecision` is what *this gateway* already did about the request, which is not the same
fact: a decision can be held here awaiting a gateway policy confirmation and never have reached the
provider.

Approvals are derived from the thread's activity log served by
`GET /api/orchestration/threads/:threadId`. They are **not** in `GET /api/orchestration/snapshot`,
which serves thread bodies empty.

### Answer

```http
POST /v1/t3/environments/env_.../threads/thread_.../approvals/req_...
authorization: Bearer PLATFORM_TOKEN
content-type: application/json

{ "decision": "acceptForSession" }
```

`202` with `{approval, decision, command, duplicate: false}` when the answer was dispatched. The
answer goes through the ordinary intent pipeline, so it produces a normal command record, a command
event timeline entry and an SSE broadcast like any other write.

Answering is **idempotent and race-safe**:

| case | answer |
|---|---|
| same decision, twice | `200` with `duplicate: true`. The provider is answered once. |
| a different decision, second | `409`. The first answer already left for the provider and cannot be recalled. |
| T3 already resolved it | `409`, before any dispatch. |
| T3 abandoned it (`stale`) | `409`, before any dispatch. T3 would have accepted the dispatch and failed asynchronously. |
| dispatch failed (T3 unreachable) | `502`, and the claim is released so the owner can retry. |
| an unknown decision | `400` naming the four real ones. |

Every answered request is broadcast to the account as `t3.approval.decided`
(`{environmentId, threadId, requestId, decision, status, commandId, observedAt}`), so a second
console tab stops offering buttons for a question that is no longer open.

## Agent Questions (structured user input)

**A third question, and not an approval of either kind.** The two sections above answer a *permission*
question — the gateway refused to send something (`/v1/commands/:id/approve|reject`), or the agent is
asking permission to act (`.../approvals/:requestId`). This one is different in kind: the agent needs
you to **tell it something** — "which database should I migrate?", "pick a branch name" — and the
answer is a **value**, not a verdict.

T3 keeps them apart in its own code. A `tool_user_input` request produces **no approval activity at
all** (`src/orchestration/Layers/ProviderRuntimeIngestion.ts:372` and `:403` return `[]` for it);
it travels on its own activity pair, `user-input.requested` / `user-input.resolved`, and is answered
with its own command, `thread.user-input.respond`. Three blocking kinds, three id spaces, three
routes. They never share a list.

### The question shapes

A single request carries **many** questions. Each is (`packages/contracts/src/providerRuntime.ts`):

```
{ id, header, question, options: [{label, description}], multiSelect? }
```

`options` is a required array that may be empty, and that is what produces the three shapes:

| shape | when | a valid answer |
|---|---|---|
| `single-choice` | `options` non-empty, `multiSelect` false | exactly one option **label**, as a string |
| `multi-choice` | `options` non-empty, `multiSelect` true | a non-empty, duplicate-free array of option labels |
| `free-text` | `options` empty | a non-empty string, at most 4000 characters |

There is no "supply a file path" shape and no structured value: a question is a prompt plus a list of
labelled options, and that is the entire vocabulary.

The answer key is the **question id**, verbatim. On Claude that id *is* the full question text — the
SDK looks answers up by question text (`src/provider/Layers/ClaudeAdapter.ts:3782-3790`) — so the
gateway never invents a key, and never persists one either.

### Validation happens before dispatch

An answer is checked against the request's own questions **before anything leaves the gateway**, and
a mismatch is a `422` naming the legal values. This is not defensive politeness: T3 accepts the
dispatch and lets the provider deal with it, and the three providers deal with it differently and
mostly silently.

- Codex **fails** the whole response for a value that is not a string, a string array, or
  `{answers: string[]}` (`src/provider/Layers/CodexSessionRuntime.ts:792`).
- OpenCode **silently answers `[]`** for a value it does not recognise
  (`src/provider/opencodeRuntime.ts:376`) — the agent gets an empty answer and carries on.
- xAI **silently relabels** an unrecognised value as an "Other" note
  (`src/provider/acp/XAiAcpExtension.ts:133-155`).

So free text sent to a three-option question would, depending on the provider, fail loudly, vanish,
or arrive as an annotation. Refusing it here with the options named is the only honest answer.

### List

```http
GET /v1/t3/environments/env_.../threads/thread_.../user-input
authorization: Bearer PLATFORM_TOKEN
```

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "requests": [
    {
      "kind": "question",
      "requestId": "req_...",
      "threadId": "thread_...",
      "questions": [
        {
          "id": "Which database should I migrate?",
          "header": "Database",
          "question": "Which database should I migrate?",
          "options": [{ "label": "staging", "description": "The shared staging database" }],
          "multiSelect": false,
          "shape": "single-choice"
        }
      ],
      "status": "pending",
      "answerable": true,
      "deviceAnswerable": true,
      "answers": null,
      "failure": null,
      "localAnswer": null
    }
  ],
  "canAnswer": true
}
```

`status` is `pending`, `resolved` (T3 recorded an answer), or `stale` (T3 abandoned the request).
The stale wording for a question is **not** the approval wording — T3 keeps four distinct spellings
(`src/orchestration/decider.ts:49-52`) — so the two are matched separately.

`localAnswer` is what *this gateway* already did, and it carries an `answersHash` rather than the
answers: see below.

Like provider approvals, these are derived from the thread's activity log served by
`GET /api/orchestration/threads/:threadId`, never from `GET /api/orchestration/snapshot`.

### Answer

```http
POST /v1/t3/environments/env_.../threads/thread_.../user-input/req_...
authorization: Bearer PLATFORM_TOKEN
content-type: application/json

{ "answers": { "Which database should I migrate?": "staging" } }
```

`202` with `{request, answer, command, duplicate: false}`. The answer goes through the ordinary
intent pipeline (`user_input_response`), so it produces a normal command record, a command event
timeline entry and an SSE broadcast like any other write.

Idempotency is keyed on a **fingerprint of the validated answers**:

| case | answer |
|---|---|
| the same answers, twice | `200` with `duplicate: true`. The provider is answered once. |
| different answers, second | `409`. The first answer already left for the provider. |
| an answer that does not fit the question | `422`, before any dispatch, naming the legal values. |
| a question not on this request | `422`. A mistyped question id would otherwise drop the real answer silently. |
| a question left unanswered | `422`. Every question on the request must be answered. |
| T3 already resolved it | `409`, before any dispatch. |
| T3 abandoned it (`stale`) | `409`, before any dispatch. |
| dispatch failed (T3 unreachable) | `502`, and the claim is released so the owner can retry. |

Every answered question is broadcast to the account as `t3.user-input.answered`
(`{environmentId, threadId, requestId, answersHash, status, commandId, observedAt}`), so a second
console tab stops offering the form.

### The answers are never persisted

A question id is question text and a free-text answer is whatever the owner typed, so both are user
content. The durable record — `providerUserInputAnswers` in every store implementation — holds a
SHA-256 **fingerprint** of the canonicalised answer set and nothing readable. The dispatched command
row records `{type: "thread.user-input.respond", requestId, answerCount}` with the answers stripped,
and support diagnostics collapse a `user_input_response` intent to a count and a digest. The words
are relayed live through the thread stream and kept nowhere.

### Answering a question is a capability

`user_input_response`, held by `next-coder` and `power-controller` and not by `read-only`.
Deliberately **one** capability rather than two: the `approval_response` / `approval_response_persistent`
split exists because `acceptForSession` writes a standing permission rule that outlives the moment,
and nothing here does that — an answer is consumed by the turn that asked. Free text is the most
powerful shape and is exactly as powerful as `agent_prompt`, which every profile carrying
`user_input_response` already has.

What *is* restricted is where an answer may come from; see the device section below.

## Observability Summary

Fetch a user-scoped reliability summary for dashboards and support triage:

```http
GET /v1/observability/summary
authorization: Bearer PLATFORM_TOKEN
```

The summary rolls up device presence, firmware versions, low battery devices, T3 environment health and token expiry, command status/latency metrics, and media processing failures:

```json
{
  "summary": {
    "devices": {
      "total": 2,
      "online": 1,
      "offline": 1,
      "lowBatteryDevices": 1
    },
    "environments": {
      "reachable": 1,
      "unreachable": 0,
      "tokenExpired": 0,
      "tokenExpiringSoon": 1
    },
    "commands": {
      "failed": 1,
      "acknowledgement": {
        "medianMs": 148,
        "p95Ms": 300
      }
    },
    "media": {
      "failedProcessing": 0,
      "pendingProcessing": 1
    }
  }
}
```

## Support Diagnostics

Export a redacted support bundle for the current account:

```http
GET /v1/support/diagnostics
authorization: Bearer PLATFORM_TOKEN
```

The bundle includes current display state, observability summary, devices, T3 environments and health, media metadata, saved macro metadata, recent commands, and recent audit events. It does not include device secrets, API token hashes, T3 access tokens, media file paths, or media bytes. Prompt text, shell commands, transcripts, media prompts, and macro prompt text are replaced with length and SHA-256 metadata.

## Web / Phone Intent

User-authenticated clients can send the same normalized intent model without device credentials:

```http
POST /v1/intents
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "clientRequestId": "web:18de0d08-e7aa-41cb-a9ef-fc9a374bc356",
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "agent_prompt",
    "text": "Continue from the dashboard."
  }
}
```

`clientRequestId` is the durable idempotency identity for a mutating agent request. It is 8–128
URL-safe characters and is scoped to the authenticated user or device, operation, and actor. Reuse
with the same canonical request returns the original command and `duplicate: true`; reuse for
different content returns `409` with `code: "idempotency_conflict"`. A retry racing the first call
returns `202` with `recovery: "processing"` and does not dispatch again.

The gateway stores only a SHA-256 request fingerprint and a command reference for 24 hours, bounded
to 1,000 receipts per owner. Prompt text, transcripts, paths, attachment content, result bodies, and
connector idempotency keys are not present in the receipt. Older clients that omit the field receive
a server-generated compatibility id, but cannot recover that id after their own restart.

Recover a web request without resending it:

```http
GET /v1/requests/web%3A18de0d08-e7aa-41cb-a9ef-fc9a374bc356
authorization: Bearer PLATFORM_TOKEN
```

For first-thread launch, append `?operation=thread.launch`. Devices use
`GET /v1/device/requests/:clientRequestId`; device-created threads append
`?operation=thread.create`. Responses contain `{request,command?}`. The receipt records the command's
initial accepted state; the returned command is authoritative for later arbiter reconciliation.

## Saved Macros

Macros are user-owned saved intent templates. They can store a default T3 environment and thread, or use the values supplied at run time.

```http
GET /v1/macros
authorization: Bearer PLATFORM_TOKEN
```

```http
POST /v1/macros
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "label": "Run tests",
  "environmentId": "env_...",
  "threadId": "thread_...",
  "intent": {
    "type": "shell_input",
    "command": "npm test"
  }
}
```

Run a saved macro through the same policy and approval pipeline as normal intents:

```http
POST /v1/macros/macro_.../run
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

Saved-action and macro run bodies accept the same `clientRequestId`. A multi-step saved-action macro
derives a stable child id for each step, so replay neither duplicates a completed step nor conflicts
one step with the next.

```json
{
  "environmentId": "env_override_optional",
  "threadId": "thread_override_optional"
}
```

Delete a saved macro:

```http
DELETE /v1/macros/macro_...
authorization: Bearer PLATFORM_TOKEN
```

User-authenticated clients can also upload media directly:

```http
POST /v1/media
authorization: Bearer PLATFORM_TOKEN
content-type: application/json
```

```json
{
  "kind": "image",
  "contentType": "image/png",
  "dataBase64": "BASE64_BYTES"
}
```

## Application

The React/Vite application is the primary UI and is served from:

```text
http://127.0.0.1:3996/
```

The React application can register or claim devices, rotate device secrets, revoke devices, pair or
dependency-preview/remove T3 environments, upload media, send prompts with ordered stored-media
attachments, approve or reject high-risk Next Coder commands, request status, stop sessions,
review audit activity, answer provider approvals and structured questions, read streamed messages
and tools, and inspect T3-native task/subagent/background work. T3 supplies the task identity,
status, and optional parent links; Next Coder does not create a second orchestrator or infer a
graph from model prose. Durable privacy-minimal in-app notifications, optional queued Web Push, and
scheduled-worker liveness are implemented; deployed Web Push/live-T3/browser/hardware qualification
remains tracked in [roadmap/IMPLEMENTATION-STATUS.md](../roadmap/IMPLEMENTATION-STATUS.md).

## Display State And Events

User clients can fetch compact display state:

```http
GET /v1/display
authorization: Bearer PLATFORM_TOKEN
```

Devices can fetch display state using device credentials:

```http
GET /v1/device/display
x-device-id: dev_...
x-device-secret: ...
```

Display `counts` include `onlineDevices` and `offlineDevices`, derived from the same server-side device presence calculation.

Devices can fetch gateway-managed runtime config:

```http
GET /v1/device/config
x-device-id: dev_...
x-device-secret: ...
```

```json
{
  "deviceId": "dev_...",
  "config": {
    "environmentId": "env_...",
    "projectId": null,
    "threadId": "thread_...",
    "defaultPrompt": "Continue the current task, inspect progress, and run relevant tests.",
    "shellCommand": "npm test",
    "menu": ["status", "prompt", "shell", "macro", "media", "stop"]
  }
}
```

Once `environmentId` and `threadId` are configured, device intent requests can omit those fields and the gateway will apply the saved defaults. Status intents only require `environmentId`.

### Device environment, project and thread selection

A controller browses three levels, each scoped by the one above it. The full wire format
and the firmware-side flow live in [hardware-protocol.md](hardware-protocol.md#environment-project-and-thread-api);
this is the endpoint summary.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/device/environments` | The claiming owner's environments, with the bound one flagged |
| POST | `/v1/device/config/environment` | Bind the device to one of them |
| GET | `/v1/device/projects` | Projects in the bound environment, from the T3 snapshot |
| POST | `/v1/device/config/project` | Set the active project |
| GET | `/v1/device/threads` | Threads in the bound environment, narrowed to the active project |
| POST | `/v1/device/threads` | Create a thread in the active project and select it |
| POST | `/v1/device/config/thread` | Set the active thread |

All seven are device realm (`x-device-id` + `x-device-secret`) and require a claimed device.

```http
GET /v1/device/environments
x-device-id: dev_...
x-device-secret: ...
```

```json
{
  "environmentId": "env_bound",
  "environments": [
    { "id": "env_bound", "label": "Workshop mac", "status": "ready", "tokenExpired": false, "selected": true },
    { "id": "env_spare", "label": "Spare T3", "status": "ready", "tokenExpired": false, "selected": false }
  ]
}
```

Only the claiming owner's environments are listed, and only these five fields — `baseUrl`, scopes
and anything token-bearing never cross into the device realm. This route answers `200` with no
environment bound, because a device that has none is exactly the one that needs the list.

```http
POST /v1/device/config/environment
x-device-id: dev_...
x-device-secret: ...
content-type: application/json

{ "environmentId": "env_spare" }
```

`environmentId` is resolved through the owner's own scope, so another account's id is a `404`;
a blank or missing one is a `400`. Changing to a different environment clears `projectId` and
`threadId`, which only meant anything inside the environment being left. Re-binding the same
environment keeps both.

```http
GET /v1/device/projects
x-device-id: dev_...
x-device-secret: ...
```

```json
{
  "environmentId": "env_bound",
  "projectId": "proj_beta",
  "projects": [
    { "id": "proj_alpha", "title": "Alpha folder", "threadCount": 2, "selected": false },
    { "id": "proj_beta", "title": "Beta folder", "threadCount": 1, "selected": true }
  ]
}
```

```http
POST /v1/device/config/project
x-device-id: dev_...
x-device-secret: ...
content-type: application/json

{ "projectId": "proj_alpha" }
```

The id is validated against the live snapshot of the bound environment, so an unknown or foreign
project is a `404`. Selecting a project that does not contain the current thread clears
`threadId`; a thread already inside it is untouched. Both project endpoints return `409` when no
environment is bound and `502` with `details.code: "t3_unreachable"` when the bound T3 host cannot
be reached — the same contract the thread endpoints use.

`projectId` is `null` by default and means "the whole environment", so `GET /v1/device/threads`
keeps returning every thread for firmware that predates project selection. Once a project is set,
both the thread listing and `POST /v1/device/config/thread` are narrowed to it, and a thread with
no `projectId` in the snapshot is excluded rather than guessed at.

The owner-facing `PUT /v1/devices/:id/config` accepts `projectId` alongside `environmentId` and
`threadId`. Deleting an environment clears the `projectId` of every device bound to it.

#### Creating a thread from the device

```http
POST /v1/device/threads
x-device-id: dev_...
x-device-secret: ...
content-type: application/json

{}
```

```json
{
  "environmentId": "env_bound",
  "projectId": "proj_empty",
  "threadId": "thread_9f0c...",
  "thread": {
    "id": "thread_9f0c...",
    "title": "24 Aug 19:32 · Hosyond Touch screen",
    "status": "idle",
    "selected": true
  },
  "config": { "environmentId": "env_bound", "projectId": "proj_empty", "threadId": "thread_9f0c..." },
  "command": { "id": "cmd_...", "status": "completed", "...": "..." }
}
```

`201` on success. The body carries an optional `title`; leave it out and the gateway mints one.
The thread is created in the device's **currently bound project** — the device cannot name a
project, an environment or an owner — and the device is bound to it in the same request, because
the follow-up `POST /v1/device/config/thread` validates against the snapshot and T3's projection
has not necessarily caught up yet.

`thread` is shaped exactly like a row from `GET /v1/device/threads`, so a controller can splice it
into the list it is already rendering.

Naming, in order:

1. a `title` in the request body, trimmed, whitespace-collapsed and capped at 72 characters;
2. otherwise `"<D Mon HH:MM> · <device label>"`, e.g. `24 Aug 19:32 · Hosyond Touch screen`,
   falling back to `Controller <short id>` for an unlabelled device.

Either way the name is made unique against the environment's snapshot titles **and** the titles
this gateway minted in the last ten minutes, with a ` (2)`, ` (3)` … suffix. The second source
matters: T3 answers a dispatch as soon as the event is appended, so two creates seconds apart can
both read a snapshot that mentions neither. Note that T3 only auto-retitles a thread whose title is
its own default `"New thread"`, so the minted name is permanent — which is the point, since a
picker of identical rows is what this endpoint exists to avoid.

The model is not chosen by the device. The project's `defaultModelSelection` wins; without one the
gateway falls back to a snapshot-derived harness for the environment.

| Status | Meaning |
|---|---|
| `403` | The device profile (or user role, environment, network or time window) does not grant `thread_create`. `details.policy` names the dimension and rule. A `read-only` device is refused here. |
| `404` | The bound project is no longer in the environment's snapshot. |
| `409` | No environment bound, no project bound, or T3 reported no usable provider model (`details.code: "no_model_selection"`). |
| `502` | `details.code: "t3_unreachable"` — the snapshot read or the dispatch failed. `details.command` carries the failed command record. The device's existing thread selection is untouched. |

Devices can list and run saved macros for the claimed account:

```http
GET /v1/device/macros
x-device-id: dev_...
x-device-secret: ...
```

```http
POST /v1/device/macros/macro_.../run
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

```json
{}
```

Devices poll one route for **all three** things that can block a turn, under three separate keys:

```http
GET /v1/device/approvals
x-device-id: dev_...
x-device-secret: ...
```

```json
{
  "commands": [{ "kind": "gateway", "id": "cmd_...", "status": "approval_required" }],
  "providerApprovals": [
    {
      "kind": "provider",
      "requestId": "req_...",
      "threadId": "thread_...",
      "requestKind": "command",
      "title": "Run a command",
      "detail": "npm test",
      "requestedAt": "2026-08-24T10:00:00.000Z"
    }
  ],
  "userInputRequests": [
    {
      "kind": "question",
      "requestId": "req_q",
      "threadId": "thread_...",
      "title": "Database",
      "prompt": "Which database should I migrate?",
      "questionCount": 1,
      "shape": "single-choice",
      "options": ["staging", "production"],
      "questionId": "Which database should I migrate?",
      "answerable": true,
      "hint": null,
      "requestedAt": "2026-08-24T10:00:00.000Z"
    }
  ],
  "allowedDecisions": ["accept", "decline", "cancel"],
  "canAnswerUserInput": true
}
```

`commands` is unchanged and is what firmware already reads: gateway policy holds, answered on the
`/v1/device/approvals/cmd_.../approve|reject` routes below. `providerApprovals` is the second
question — see [Provider Approvals](#provider-approvals) — answered at
`POST /v1/device/provider-approvals/:requestId`. `userInputRequests` is the third — see
[Agent Questions](#agent-questions-structured-user-input) — answered at
`POST /v1/device/user-input/:requestId`. `allowedDecisions` and `canAnswerUserInput` reflect the
device's own profile: a `read-only` controller **sees** what the agent is blocked on and is offered
nothing, because hiding the request would leave an owner walking past the device with no idea a turn
had stopped.

#### What a controller can and cannot answer

**`answerable` is the field firmware must read.** A 240x320 panel with five keys and no keyboard can
offer a short list and let someone press one. It cannot take dictation, hold a multi-part form, or
build a subset out of eight options with two arrow keys. So exactly one shape is answerable from the
device realm:

> **one** single-choice question, with **two to four** options, each label at most **24 characters**
> after whitespace collapsing.

Everything else arrives with `answerable: false`, `options: null`, `questionId: null`, and
`hint: "Answer this in the console."` — the exact sentence to put on screen. It is still listed,
deliberately: an owner who can see *"the agent is asking you something, answer it in the console"* is
far better served than one whose device says "Working" forever. Posting an unanswerable question to
`/v1/device/user-input/:requestId` is a `422` with the same guidance, and the claim is never taken,
so the console can still answer it.

Reading T3 is best-effort: when the host is unreachable, `providerApprovals` and `userInputRequests`
are empty, `providerApprovalsError` / `userInputError` carry the reason, and the gateway approvals in
the same response are still listed and still answerable.

```http
POST /v1/device/provider-approvals/req_...
x-device-id: dev_...
x-device-secret: ...
content-type: application/json

{ "decision": "decline" }
```

```http
POST /v1/device/user-input/req_q
x-device-id: dev_...
x-device-secret: ...
content-type: application/json

{ "answers": { "Which database should I migrate?": "staging" } }
```

The body is `{answers}` keyed by `questionId` — echo the value the poll gave back verbatim; never
construct one, because on Claude the id is the full question text. `threadId` may be supplied to
override the device's bound thread. `403` for a device whose profile lacks `user_input_response`,
`422` for a question this hardware cannot answer or an answer that does not fit it, `409` for one
T3 has already resolved or abandoned.

```http
POST /v1/device/approvals/cmd_.../approve
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

```http
POST /v1/device/approvals/cmd_.../reject
x-device-id: dev_...
x-device-secret: ...
content-type: application/json
```

Devices can poll firmware update metadata:

```http
GET /v1/device/firmware?version=0.1.0&hardware=e213-esp32-s3r8
x-device-id: dev_...
x-device-secret: ...
```

If a newer release exists:

```json
{
  "updateAvailable": true,
  "currentVersion": "0.1.0",
  "hardwareModel": "e213-esp32-s3r8",
  "manifest": {
    "version": "0.2.0",
    "hardwareModel": "e213-esp32-s3r8",
    "url": "https://cdn.example.com/firmware/next-coder-0.2.0.bin",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sizeBytes": 901385,
    "mandatory": false,
    "releaseNotes": "Adds runtime config polling.",
    "createdAt": "2026-06-14T21:00:00.000Z",
    "signature": "..."
  }
}
```

The current firmware scaffold can download and apply update images when `ENABLE_OTA_APPLY=1`. It checks the downloaded image size and SHA-256 before committing the OTA partition. If `REQUIRE_OTA_SIGNATURE=1`, it also validates the manifest HMAC against `OTA_MANIFEST_VERIFY_KEY`.

User clients can subscribe to state changes with Server-Sent Events:

```text
GET /v1/events?token=PLATFORM_TOKEN
```

Devices can subscribe with query credentials when headers are not convenient:

```text
GET /v1/device/events?deviceId=dev_...&deviceSecret=...
```

The event stream emits:

```text
connected
heartbeat
state.changed
device.refresh
firmware.changed
threads.changed
t3.snapshot
media.job
command.reconciled
t3.approval.decided
t3.user-input.answered
t3.thread.snapshot
t3.thread.event
t3.thread.status
notification.created
notification.updated
background.liveness.changed
```

### Notifications

The signed-in owner's inbox is durable and privacy-minimal. Rows contain static copy and opaque
environment/thread/command navigation ids only; prompts, transcripts, file paths, provider details,
question/answer text, and raw provider request ids are not stored or emitted.

```text
GET /v1/notifications?limit=50
GET /v1/notifications?after=42&limit=50
GET /v1/notifications?before=17&limit=50
POST /v1/notifications/notification_.../read
POST /v1/notifications/read-all
DELETE /v1/notifications/notification_...
```

An initial read is newest-first. `nextCursor` is the highest delivered sequence and is used with
`after` for chronological reconnect replay. `oldestCursor` is the lowest delivered sequence and is
used with `before` for older inbox pages. `after` and `before` cannot be combined. Read and dismiss
are idempotent; dismiss is a soft tombstone. Rows are retained for at most 30 days and 1,000 rows per
owner. Provider and agent-question source ids are represented only by an opaque deduplication hash,
which is not returned.

There is deliberately no device notification inbox. Controllers retain their existing bounded,
capability-gated approval, user-input, and result projections; an owner's general inbox can reveal
thread or command existence outside a controller's scope.

### Optional Web Push

```text
GET /v1/push/config
GET /v1/push/subscriptions
POST /v1/push/subscriptions
POST /v1/push/subscriptions/revoke
DELETE /v1/push/subscriptions/push_subscription_...
```

`GET /v1/push/config` returns only whether delivery is supported plus the active public VAPID key
and key id. Private keys never cross this boundary. Registration accepts the browser's standard
`{ endpoint, keys: { p256dh, auth } }` shape and rejects non-HTTPS or non-allowlisted endpoint hosts.
Public subscription records contain an opaque id, VAPID key id, timestamps, and bounded failure
code; endpoint capability URLs and encryption keys are never returned.

Revocation is owner-scoped either by opaque subscription id or by the current browser endpoint.
Notification creation queues idempotent durable delivery work. Internal background task
`push.deliver` processes it in bounded batches. A stored `acceptedAt` means only that the push
service accepted the request, never that the browser displayed it. See `docs/notifications.md` for
payload privacy, retry, terminal cleanup, VAPID rotation, and provider-host configuration.

### Scheduled worker liveness

```text
GET /v1/background/liveness
```

The response reports only the scheduled control-plane worker:

```json
{
  "scheduledWorker": {
    "status": "healthy",
    "lastAttemptAt": "2026-08-27T20:00:00.000Z",
    "lastSuccessAt": "2026-08-27T20:00:00.000Z",
    "lastFailureAt": null,
    "nextExpectedBy": "2026-08-27T20:10:00.000Z",
    "failureCode": null,
    "expectedIntervalMs": 300000
  },
  "observedAt": "2026-08-27T20:00:01.000Z"
}
```

Statuses are `healthy`, `degraded`, `stale`, `not_configured`, and `unknown`. Connector, T3, and
provider health remain on their existing environment health surfaces; they are intentionally not
folded into this result. In cloud mode, a dedicated Cron -> Queue -> private Container heartbeat is
the durable evidence behind this status.

`device.refresh` targets one device and carries the bounded resources it should mark due. Current
values are `environments`, `projects`, `config`, `threads`, `controls`, `approvals`, `display`, and
`gateway`; firmware can ignore resources it does not implement, coalesces a burst, and continues
fetching one resource at a time.

`firmware.changed` is broadcast for release publication/withdrawal and targeted policy changes.
Compatible devices poll the manifest immediately instead of waiting for their six-hour fallback.
Mandatory releases resolve to automatic installation for every compatible claimed device.

`threads.changed` is emitted after an owner create, rename, archive, or delete command is accepted
by T3. It is broadcast to every connected dashboard and device owned by that user:

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "action": "renamed",
  "title": "Release checklist",
  "clearedDeviceCount": 0,
  "bindingRepairFailureCount": 0,
  "changedAt": "2026-08-25T15:00:00.000Z"
}
```

Create, archive, and delete omit `title`. Any device bound to a removed thread is cleared before the
event is published, and `clearedDeviceCount` reports how many bindings were repaired. Dashboard
clients apply rename/removal deltas immediately and invalidate only the affected workspace cache;
the delayed authoritative snapshot cannot resurrect the stale row.

## Live Thread Streams

`state.changed` and `t3.snapshot` tell a client that *something* moved; the `t3.thread.*` events
carry what the agent is actually doing, as it does it. They come from a real subscription to T3's
`orchestration.subscribeThread` (see `src/threadStream.mjs`), not from polling.

A subscription exists only while somebody says they are watching. That statement is a lease:

```text
POST   /v1/t3/environments/:environmentId/threads/:threadId/watch
DELETE /v1/t3/environments/:environmentId/threads/:threadId/watch
```

```json
{
  "watch": {
    "userId": "user_...",
    "environmentId": "env_...",
    "threadId": "thread_...",
    "state": "live",
    "sequence": 40213,
    "expiresAt": "2026-08-24T12:01:30.000Z",
    "failures": 0,
    "lastError": null
  }
}
```

`POST` both registers and renews, so a client should call it on a timer comfortably inside the
lease (default `THREAD_STREAM_WATCH_TTL_MS`, 90s). Stop calling it and the subscription is dropped
within one TTL — a closed tab needs no cleanup. `DELETE` is the polite early release. A device
polling `GET /v1/device/thread-output` renews its own watch automatically; firmware has no watch
route to call and needs none.

### The events

`t3.thread.snapshot` — the whole thread, and an instruction to start from it.

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "reset": true,
  "gap": false,
  "snapshotSequence": 40200,
  "page": null,
  "thread": { "id": "thread_...", "messages": [], "activities": [], "session": null },
  "observedAt": "2026-08-24T12:00:00.000Z"
}
```

`reset` is always true: a snapshot replaces the client's view of the thread rather than merging
into it. `gap` is the one that matters — see below.

`t3.thread.event` — one T3 orchestration event, in order.

```json
{
  "environmentId": "env_...",
  "threadId": "thread_...",
  "sequence": 40201,
  "eventId": "evt_...",
  "type": "thread.activity-appended",
  "occurredAt": "2026-08-24T12:00:01.000Z",
  "commandId": null,
  "event": { "…": "the full OrchestrationEvent" },
  "observedAt": "2026-08-24T12:00:01.000Z"
}
```

`type` is one of the six thread-detail events T3 streams (`isThreadDetailEvent`, src/ws.ts:271):
`thread.message-sent`, `thread.activity-appended`, `thread.proposed-plan-upserted`,
`thread.turn-diff-completed`, `thread.reverted`, `thread.session-set`.

**`thread.message-sent` with `streaming: true` carries a DELTA, not the whole message.** Append it
to the message with the same `messageId`; a frame with `streaming: false` carries the final full
text, or empty text meaning "keep what you have". This is T3's own projector rule
(`src/orchestration/projector.ts:497-515`) and a client that treats a delta as the whole message
will show the last few tokens of every reply.

For T3-native agents and background work, `thread.activity-appended.payload.activity.kind` is one
of `task.started`, `task.progress`, `task.updated`, or `task.completed`. The activity payload fields
used by Next Coder are the exact T3 0.0.32 contract fields:

| Field | Meaning |
|---|---|
| `taskId` | Stable task identity and fold key |
| activity `turnId` | Exact T3 turn attribution for the task row |
| `agentKind` | T3-stamped `agent` or `background`; absent legacy rows remain generic tasks |
| `parentAgentId` | Explicit parent-agent edge |
| `agentId` | Explicit owning-agent edge for nested task/tool activity |
| `taskType`, `title`, `role`, `model`, `effort`, `agentPath` | Optional T3 task identity |
| `workflowName`, `phaseIndex`, `phaseTitle`, `phases`, `attempt` | Optional workflow evidence |
| `status` | `pending`, `running`, `waiting`, `idle`, `completed`, `failed`, `cancelled`, or `interrupted` |
| `summary`, `detail`, `error`, `lastToolName` | Bounded latest task detail |
| `typedUsage` | Typed token/tool/duration rollup |
| `usageSnapshot` | The stable progress row carries usage only and must not change task status |

`tool.progress.payload.taskId` and `tool.started|updated|completed.payload.agentId` provide exact
tool attribution. Without one of those fields, a tool stays in the parent thread; its wording is
never treated as an agent link. Snapshot replacement, event replay/dedup, the 64-node/16-activity
client bounds, missing-parent behavior, and the lack of certified per-task commands are specified in
[T3-native agents and work](t3-work-graph.md).

`idle` is displayed as a waiting/resumable task but does not count as active background liveness,
matching T3's own `ThreadBackgroundLiveness` service. `waiting` remains active.

`t3.thread.status` — connection state, so a client can say "live" rather than guess.

```json
{ "environmentId": "env_...", "threadId": "thread_...", "state": "live", "sequence": 40201 }
```

`state` is one of `connecting`, `resuming`, `live`, `reconnecting` (with `attempt`, `retryInMs`
and `error`), or `stopped` (with `reason`). `live` means T3 sent its completion marker: the initial
snapshot or catch-up replay is finished and everything after this is happening now.

### Ordering, resume, and a gap that cannot be filled

`sequence` is T3's global event-log sequence and is the ordering key. The gateway delivers strictly
increasing sequences per thread and drops anything at or below its cursor, so a client can apply
events in arrival order without deduplicating them itself.

On a dropped socket the gateway reconnects with backoff and resumes from its cursor, and T3 replays
the events after it. But T3 refuses to replay more than 1000 events, and refuses a cursor ahead of
its own head (`THREAD_RESUME_MAX_GAP`, src/ws.ts:307): in that case it sends a fresh snapshot
instead of the replay, because a truncated replay would drop events silently.

That is what `gap: true` on a `t3.thread.snapshot` means. **Nothing is lost** — the snapshot is the
thread's current state in full — but the *intermediate history* is: the individual events between
the old cursor and now were never delivered, only their result. A client should replace the thread
with the snapshot rather than appending to what it had, and may tell the reader that some
intermediate steps were skipped.

### Commands settle faster, and still only once

A live `thread.session-set` carrying an error, or a finished assistant message, reconciles a
`dispatched` command immediately instead of waiting for the next poll. `command.reconciled` now
carries `source: "stream" | "snapshot"` naming which evidence decided it. The snapshot poller still
runs — it also serves environment health, the compressed device screen and thread titles, none of
which a thread subscription covers — but the two share one arbiter (`src/commandArbiter.mjs`), so
a command is decided exactly once no matter which sees the evidence first.

## Local End-To-End Demo

Terminal 1:

```bash
node scripts/mock-t3.mjs
```

Terminal 2:

```bash
PORT=8877 DATA_FILE=.data/dev.json node src/server.mjs
```

Terminal 3:

```bash
NEXT_CODER_URL=http://127.0.0.1:8877 node scripts/simulate-device.mjs
```

Or run the automated local smoke flow:

```bash
NEXT_CODER_URL=http://127.0.0.1:8877 node scripts/smoke-local.mjs
```

Then register the mock T3 environment:

```bash
curl -X POST http://127.0.0.1:8877/v1/t3/environments \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer PLATFORM_TOKEN' \
  -d '{"label":"Mock T3","baseUrl":"http://127.0.0.1:3999","pairingToken":"dev"}'
```
