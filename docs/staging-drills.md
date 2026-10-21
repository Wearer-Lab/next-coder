# Staging drills

Three runnable drills for the [completion plan](../roadmap/completion-plan.md) Phase 4 hosted
qualification matrices that previously had no tooling at all. Each one exercises a deployed origin
from a laptop, asserts a bounded contract, and writes a redacted machine-readable record on stdout.

They are companions to [Staging qualification](staging-qualification.md), not a replacement: the
qualification harness proves the credential-free boundary, connector-first readiness, and the first
completed command. These drills prove the revocation, replay, and media-lifecycle behaviour that
an operator would otherwise improvise by hand.

They share the qualification harness's rules, which are not negotiable:

- the target origin is an explicit `--base-url` argument; there is no implicit default;
- HTTPS is mandatory for any non-loopback target, redirects are refused, and every response and
  timeout is bounded;
- **credentials are read only from the environment or a mode-`0600` file.** No option accepts a
  token as a command-line value, so a token never enters shell history or the process argument list;
- **every mutating step is behind an explicit opt-in flag** and is refused without it;
- prompts, transcripts, media, filenames, storage keys, tokens, tickets, upstream error bodies, and
  raw identifiers never enter the record. Identifiers appear as truncated SHA-256 references;
- **a check that did not run is emitted as `skipped`, never as a pass**, and any skipped check makes
  the whole record non-passing. A preflight run therefore always reports `"result": "failed"` and
  exits nonzero. That is deliberate: a preflight record cannot be mistaken for proof.

## Evidence shape

Every drill emits `next-coder.staging-drill.v1`, the same shape as
`next-coder.staging-qualification.v1` plus a `drill` name and a `mode`, so a drill record can
join an evidence bundle beside a qualification record:

```json
{
  "schema": "next-coder.staging-drill.v1",
  "drill": "request-replay",
  "mode": "exercise",
  "result": "passed",
  "startedAt": "2026-09-09T19:41:55.678Z",
  "finishedAt": "2026-09-09T19:41:55.733Z",
  "durationMs": 55,
  "target": { "origin": "https://staging.example.com" },
  "summary": { "passed": 9, "failed": 0, "skipped": 0 },
  "checks": [
    { "name": "first_request_accepted", "status": "passed", "durationMs": 13, "httpStatus": 200,
      "commandRef": "sha256:aefd6241f20e725f", "requestRef": "sha256:2497b45a9e1d8a13" }
  ]
}
```

`mode` is `preflight` or `exercise`. A check's `name`, `status`, `durationMs` and `code` come from
the drill's own envelope and cannot be overwritten by an observation, so a record's outcome is never
a value the gateway supplied.

Exit codes: `0` when every check passed, `1` when any check failed or was skipped — a rejected
configuration is reported as a failed `configuration` check, so it exits `1` with a record — and `2`
when the command line itself, or the token file it named, could not be read, which produces a record
with the same shape and no target.

## Shared configuration

| Variable | Meaning |
|---|---|
| `NEXT_CODER_DRILL_URL` | Target origin; equivalent to `--base-url` |
| `NEXT_CODER_DRILL_ACCESS_TOKEN` | Platform session token for the drill account |
| `NEXT_CODER_DRILL_ENVIRONMENT_ID` | Environment id for the replay drill |
| `NEXT_CODER_DRILL_DEPLOYMENT_MODE` | Expected `/v1/auth/config` deployment mode; defaults to `cloud` |
| `NEXT_CODER_DRILL_REQUEST_TIMEOUT_MS` | Per-request timeout |

`--access-token-file PATH` reads the token from a regular mode-`0600` file instead. A
group- or world-readable file is refused. `--allow-http-loopback` exists only so the drills can be
rehearsed against a local `node src/server.mjs`; it cannot relax HTTPS for a real host.

Use a dedicated drill account. These drills create and destroy control-plane state.

## 1. Connector revocation — completion plan 4.2

```bash
export NEXT_CODER_DRILL_ACCESS_TOKEN='staging-session-token'

# Preflight: reads only. Always reports "failed" because every revocation check is skipped.
npm run drill:connector-revocation -- --base-url 'https://staging.example.com'

# The drill itself.
npm run drill:connector-revocation -- \
  --base-url 'https://staging.example.com' \
  --exercise-revocation \
  > staging-drill-connector-revocation.json

unset NEXT_CODER_DRILL_ACCESS_TOKEN
```

### What it proves

The drill creates **its own throwaway environment**, enrolls a connector credential into it through
the ordinary `POST /v1/t3/connect-sessions` → `POST /v1/connectors/enroll` path, and then:

- `socket_ticket_minted` — the fresh credential can mint an edge socket ticket (`201`);
- `connector_revoked` — the owner's `DELETE /v1/connectors/:id` returns the connector marked
  `revoked` with a `revokedAt` timestamp;
- `revoked_credential_refused` — the same credential is now refused a ticket with `401`, so no new
  socket attempt can even begin;
- `revocation_visible_to_owner` — the environment has zero live connectors;
- `replacement_enrollment_succeeded` — a replacement enrollment issues a **distinct** credential
  that can mint a ticket;
- `superseded_connector_stays_revoked` — after replacement there is exactly one live connector, the
  revoked one has not come back, and its credential is still refused;
- `drill_environment_archived` — the drill archives the environment it created. Cleanup is itself a
  recorded check, so a leftover environment is visible in the record rather than silent.

### What it does **not** prove

- **Nothing about a live socket.** The drill never opens a WebSocket, so it observes no established
  connection closing.
- **Nothing about heartbeats.** No connector process is running, so "the heartbeat stopped" is not
  observed — only that the credential can no longer authenticate.
- **Nothing about in-flight work terminalising.** There is no live T3 behind the drill environment,
  so no dispatched command is in flight to be terminalised.
- **Nothing about the edge rejecting an already-minted ticket.** The ticket-consume capability is a
  private control-plane route that answers `404` at the public origin by design (that refusal is
  itself checked by `npm run qualify:staging`), so a laptop cannot attempt the race.

Those four remain a hosted operator step with a live connector process attached to the deployed
edge, as [Production security](production-security.md) describes. This drill covers the credential
and enrollment half of matrix 4.2 and says so.

### Safety

The drill **never enrolls into an environment it did not create**, and there is no option to make it
do so. Enrollment is rotation-by-replacement: it revokes whatever connector currently serves the
environment, so pointing it at a working environment would disconnect the operator's real connector.
If enrollment fails after the environment row was created, the record reports
`drill_environment_archived` as skipped with `drill_environment_not_created`; check
`GET /v1/t3/environments` and archive the leftover from the console.

## 2. Durable request replay — completion plan 4.3

```bash
export NEXT_CODER_DRILL_ACCESS_TOKEN='staging-session-token'

npm run drill:request-replay -- \
  --base-url 'https://staging.example.com' \
  --environment-id 'env_staging_test' \
  --exercise-replay \
  > staging-drill-request-replay.json

unset NEXT_CODER_DRILL_ACCESS_TOKEN
```

### What it proves

The drill generates one `clientRequestId` — never accepted from the command line, so a re-run cannot
inherit an earlier run's envelope — and submits a single `status` intent with it:

- `first_request_accepted` — the intent is accepted and returns exactly one command;
- `identical_replay_returns_same_command` — the same id with the same content returns
  `duplicate: true` and the **same** command id, rather than dispatching a second time;
- `receipt_persisted` — `GET /v1/requests/:clientRequestId` returns the privacy-minimal receipt,
  bound to that command, carrying the recorded HTTP status and no request content;
- `conflicting_fingerprint_refused` — the same id with a different fingerprint is refused `409` with
  `details.code === "idempotency_conflict"`. A `409` without that code is not accepted as proof;
- `receipt_unchanged_by_conflict` — the refused retry did not rewrite the receipt;
- `exactly_one_command_created` — across all three submissions, exactly one command exists for that
  environment since the drill started, and it is the one the first request returned.

A `status` intent is used because it is the only mutating intent that costs no provider turn while
still travelling the whole envelope path: claim → policy → connector → T3 snapshot → settle. The
environment must therefore be reachable; if it is not, the first request fails and every later check
is reported as skipped rather than invented.

### What it does **not** prove

- **No Durable Object eviction and no deploy rollover.** The rest of matrix 4.3 requires a
  deployment to be rolled over mid-request, which is an operator action driven from
  [Protected staging release and rollback](staging-release.md), not from this script.
- **No client-side journal recovery.** It proves the server side of the contract from a cooperating
  client; it does not kill a browser or a controller between dispatch and response, so the browser
  local-storage journal and the firmware NVS journal are untested here.
- **Only the owner realm and only the intent envelope.** The device-realm envelope
  (`POST /v1/device/intents`), saved-action and macro runs, thread launch, and the media upload
  session envelope are not exercised.
- **`GET /v1/commands` is unpaginated**, so the final count check reads the account's whole command
  list. Use a dedicated drill account; a very large account can exceed the response bound and the
  check will fail with `response_too_large` rather than guess.

## 3. Media upload lifecycle — completion plan 4.6

```bash
export NEXT_CODER_DRILL_ACCESS_TOKEN='staging-session-token'

npm run drill:media-lifecycle -- \
  --base-url 'https://staging.example.com' \
  --exercise-media \
  > staging-drill-media-lifecycle.json

unset NEXT_CODER_DRILL_ACCESS_TOKEN
```

### What it proves

The fixture is a fixed 67-byte 1×1 PNG compiled into the script. **No user media is read or
uploaded.** The drill walks the raw session state machine described in [the API reference](api.md):

- `upload_session_created` — `POST /v1/media/uploads` returns a `pending` session whose projection
  carries no storage key, filename, transcript, or client request id;
- `short_body_refused` — a body one byte short is refused `422`;
- `digest_mismatch_refused` — a body of the correct length whose SHA-256 differs is refused `422`;
- `content_type_mismatch_refused` — a `PUT` whose content type is not the declared one is refused
  `415`;
- `content_accepted` — the exact bytes are accepted and the session becomes `uploaded`;
- `finalize_creates_media` — finalization returns a media row whose digest and content type match;
- `finalize_is_idempotent` — a second finalize returns the same media id, not a second row;
- `finalized_bytes_round_trip` — the owner read returns byte-identical content, and the
  `x-media-sha256` header agrees with the bytes;
- `unsigned_content_access_refused` — `GET /v1/media/:id/content` is refused `403` with no token,
  and refused `403` again for a well-formed, unexpired, wrongly-signed token, so the refusal is a
  signature check and not a parse failure;
- `abandoned_session_aborted` — a second session that never receives bytes is aborted, still reads
  back as `aborted`, and is no longer writable (`409`);
- `retention_runner_reachable` — `POST /v1/media/purge-expired` answers with the retention
  projection. Its counts are **recorded, not asserted**;
- `drill_media_deleted` — the drill deletes the media it created, as a recorded check.

### What it does **not** prove

- **No TTL expiry.** The drill does not wait out `MEDIA_UPLOAD_SESSION_TTL_MS` (15 minutes by
  default), so expiry-driven session cleanup and the staged-object sweep are not observed — only the
  runner's reachability and the explicit abort path.
- **No signed-URL expiry.** A genuine signed media URL is minted only into a T3 dispatch payload and
  stripped before persistence, so a drill cannot obtain one. Only the refusal of unsigned and forged
  tokens is proven.
- **No storage-backend claim.** The drill asserts nothing about whether R2, S3, or local disk served
  the bytes; the record shape is identical either way by design.
- **No voice pipeline.** Transcription, the review gate, auto-send policy, notification replay, Web
  Push delivery, VAPID rotation, and scheduled-worker liveness are all outside this drill. Those
  parts of matrix 4.6 still need the operator procedure in [Notifications](notifications.md) and a
  configured transcription provider.

## Local rehearsal

Every drill is fully testable without a deployed origin:

```bash
npm run test:staging-drills
```

The suites drive each drill against a stubbed HTTP fixture and assert both the passing path and the
failing ones — a gateway that keeps honouring a revoked credential, one that dispatches twice for
one `clientRequestId`, one that returns `409` without the conflict code, one that serves media
without a signed token, and one whose session projection leaks a storage key.

A drill may also be rehearsed end to end against a local gateway. This is a rehearsal of the script,
not hosted evidence, and the record says so through its `target.origin`:

```bash
node src/server.mjs        # AUTH_PROVIDER=dev, a scratch MEDIA_DIR
npm run drill:media-lifecycle -- \
  --base-url 'http://127.0.0.1:3996' --allow-http-loopback \
  --expected-deployment-mode 'self-hosted' --exercise-media
```

## What still has no tooling in Phase 4

| Matrix | Tooling | Why |
|---|---|---|
| 4.1 Queue/Cron ownership | none | The evidence is Cloudflare Analytics Engine and native queue metrics, read from the account, not from the origin. See [Cloud observability](cloud-observability.md). |
| 4.2 online revocation | **partial — this document** | Socket closure, heartbeat cessation, in-flight terminalisation, and the edge ticket race need a live connector process against the deployed edge. |
| 4.3 durable replay | **partial — this document** | DO eviction, deploy rollover mid-request, and client-journal recovery are operator and client actions. |
| 4.4 capacity | `npm run test:capacity` (local budget only) | The hosted `standard-1` measurement is a deployed run, not a laptop script. See [Capacity and SLO](capacity-slo.md). |
| 4.5 observability and privacy review | none | It is a human review of returned columns and log fields plus dashboard and alert delivery. |
| 4.6 media and voice | **partial — this document** | TTL expiry, real signed-URL expiry, transcription, Web Push, and scheduled liveness remain operator steps. |
| 4.7 security drill | none | TLS-only enforcement behind the proxy, rate-limit backend outage, and rotation under load need infrastructure control, not an API client. |

Nothing in this repository has been deployed. Every drill above has been exercised only against
stubbed fixtures and a local gateway; none of them has yet met a hosted origin.
