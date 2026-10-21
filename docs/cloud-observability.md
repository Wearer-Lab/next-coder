# Cloud observability and alerting

This runbook covers the Cloudflare edge Worker, environment Durable Objects, Queues, and the private
control-plane Worker/Container. The repository provides privacy-safe structured events, bindings,
sampling policy, queries, and provisional alert thresholds. It does **not** prove that a hosted
dataset, dashboard, notification policy, Queue, or Container is active. Complete the staging checks
below after an authorized deployment before treating CG-01, CG-08, or CG-12 observability as hosted
evidence.

Cloudflare creates an Analytics Engine dataset on its first write after a configured binding; the
release preflight validates the binding names and Wrangler dry-runs without creating or writing a
dataset. See Cloudflare's [Analytics Engine setup](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
and [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

## Privacy and volume contract

`cloudflare/src/telemetry.ts` and `cloudflare-control-plane/src/telemetry.ts` accept fixed event
classes and aggregate numbers only. Their type has no user, device, environment, connector, request,
path, URL, prompt, transcript, media, filename, or token field. Unknown failure strings become a
fixed error family or `other`. Numbers are clamped, successes default to a 5% random sample, and
ordinary rejected requests use a bounded 10% sample so internet scans cannot create unbounded
telemetry. Failure/degraded events and forced capacity-eviction, availability-transition,
quarantine, and rollout events are retained. Analytics/log failures never change product behavior.

Wrangler declares Workers Logs and trace instrumentation enabled but pins every platform
observability sample rate to zero and disables invocation logs. Cloudflare enriches persisted Worker
log events with invocation metadata that can include a request URL, while automatic fetch/handler
spans include `url.full`, `url.path`, and sometimes `url.query`; either violates this service's
no-raw-path/no-secret telemetry contract. See [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
the [Observability API event shape](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/),
and Cloudflare's [span attribute list](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/).
The code emits sampled fixed-schema console events only in the local environment; staging and
production use Analytics Engine and do not call `console.log` for these events. Analytics Engine is
the only configured persistent application dataset. Do not raise a platform log/trace rate
unless Cloudflare supports verified removal of all raw URL/path/query metadata for both Workers and
staging confirms the resulting field set.

The event schema is `next-coder.cloud-telemetry.v1`:

| Analytics Engine field | Meaning |
| --- | --- |
| `index1` | event kind (the only index) |
| `blob1` | schema |
| `blob2` | runtime: `edge` or `control_plane` |
| `blob3` | deployment environment |
| `blob4` | event kind |
| `blob5` | fixed operation class |
| `blob6` | `success`, `failure`, `rejected`, or `degraded` |
| `blob7` | HTTP status family |
| `blob8` | fixed error code/family |
| `blob9` | fixed lag, capacity, or startup bucket |
| `double1` | duration milliseconds |
| `double2` | item/message/socket count |
| `double3` | bytes |
| `double4` | applicable limit |
| `double5` | delivery attempts or retried-message count |
| `double6` | Queue lag or Container startup-wait milliseconds |
| `double7` | application sample rate |

Analytics Engine can apply adaptive sampling as well. Use `_sample_interval` to correct that layer;
divide by `double7` to correct the application's success sampling. Cloudflare documents weighted
aggregates in its [SQL aggregate reference](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/aggregate-functions/).

## Event coverage

- `edge_request`, `do_request`: duration, outcome, status family, and fixed route operation.
- `do_capacity`: pending requests, subscriptions, subscription bytes/items, active long polls,
  idempotency receipts, and terminal-result count/bytes. `gte_80pct`, `saturated`, and `evicted` are
  forced where applicable.
- `connector_availability`: aggregate connected, offline, operator-disconnect, and revoked
  transitions. There are deliberately no connector or environment identifiers, so this is a fleet
  transition signal, not a per-tenant uptime ledger.
- `queue_batch`: maximum batch lag plus aggregate ack/retry/quarantine outcome; `queue_quarantine`
  records a redacted application quarantine; `queue_dlq_risk` records a failed quarantine publish
  that is returned to the broker retry/DLQ policy; `queue_schedule` records cron fan-out.
- `rollout_event`: successful, degraded, or failed rollout reconciliation.
- `container_request`: total proxy duration, status, startup-wait duration/bucket, and distinct
  startup-timeout versus response-header-timeout errors. A slow startup-wait bucket is a cold-start
  **candidate**, not proof of a new Container allocation.

Broker-managed DLQ depth and delivery count remain Cloudflare platform metrics because the broker
moves a message after the Worker invocation has ended. Application quarantine and DLQ-risk events
make the local decision observable; hosted qualification must correlate them with the Queue's native
DLQ dashboard/API metric.

## Queries

Use `agent_controller_edge_staging` for edge/DO/Queue queries and
`agent_controller_control_plane_staging` for Container queries. Submit SQL using a short-lived token
with only `Account Analytics: Read`; never paste release or Worker-write credentials into a query
client.

Estimated request volume and failure rate by operation:

```sql
SELECT
  toStartOfMinute(timestamp) AS minute,
  blob5 AS operation,
  sum(_sample_interval / double7) AS estimated_requests,
  sumIf(_sample_interval / double7, blob6 = 'failure') /
    sum(_sample_interval / double7) AS failure_rate
FROM agent_controller_edge_staging
WHERE timestamp >= NOW() - INTERVAL '1' HOUR
  AND blob4 IN ('edge_request', 'do_request')
GROUP BY minute, operation
ORDER BY minute, operation
```

Weighted p50/p95 request duration:

```sql
SELECT
  blob4 AS kind,
  blob5 AS operation,
  quantileExactWeighted(0.50)(double1, _sample_interval / double7) AS p50_ms,
  quantileExactWeighted(0.95)(double1, _sample_interval / double7) AS p95_ms
FROM agent_controller_edge_staging
WHERE timestamp >= NOW() - INTERVAL '1' HOUR
  AND blob4 IN ('edge_request', 'do_request')
GROUP BY kind, operation
```

Queue lag, retry, quarantine, and DLQ-risk:

```sql
SELECT
  blob5 AS queue_class,
  max(double6) AS max_lag_ms,
  sumIf(double5, blob4 = 'queue_batch') AS retried_messages,
  sumIf(_sample_interval, blob4 = 'queue_quarantine') AS quarantines,
  sumIf(_sample_interval, blob4 = 'queue_dlq_risk') AS dlq_risks
FROM agent_controller_edge_staging
WHERE timestamp >= NOW() - INTERVAL '30' MINUTE
  AND blob4 IN ('queue_batch', 'queue_quarantine', 'queue_dlq_risk')
GROUP BY queue_class
```

Capacity pressure and retention eviction:

```sql
SELECT blob5 AS capacity, blob9 AS bucket, max(double2) AS observed_count,
  max(double3) AS observed_bytes, max(double4) AS configured_limit,
  sum(_sample_interval) AS observations
FROM agent_controller_edge_staging
WHERE timestamp >= NOW() - INTERVAL '1' HOUR AND blob4 = 'do_capacity'
GROUP BY capacity, bucket
ORDER BY capacity, bucket
```

Connector transitions and rollout health:

```sql
SELECT blob4 AS kind, blob5 AS transition, blob6 AS outcome,
  sum(_sample_interval) AS events
FROM agent_controller_edge_staging
WHERE timestamp >= NOW() - INTERVAL '1' HOUR
  AND blob4 IN ('connector_availability', 'rollout_event')
GROUP BY kind, transition, outcome
```

Container startup candidates and timeout classes:

```sql
SELECT blob5 AS operation, blob9 AS startup_bucket, blob8 AS error_code,
  quantileExactWeighted(0.95)(double6, _sample_interval / double7) AS p95_start_wait_ms,
  quantileExactWeighted(0.95)(double1, _sample_interval / double7) AS p95_total_ms,
  sum(_sample_interval / double7) AS estimated_requests
FROM agent_controller_control_plane_staging
WHERE timestamp >= NOW() - INTERVAL '1' HOUR AND blob4 = 'container_request'
GROUP BY operation, startup_bucket, error_code
```

## Dashboard and provisional alerts

Create staging panels for edge/DO p50-p95 duration and status families, Container start-wait/total
duration, Queue max lag/retries/quarantine/DLQ, DO capacity buckets/evictions, connector transitions,
and rollout outcomes. Start with these conservative thresholds, then tune from an authorized staging
soak and recorded baseline:

| Signal | Initial threshold | Response |
| --- | --- | --- |
| Edge or Container failures | >1% for 5 minutes and at least 20 estimated requests | page on-call |
| Edge or DO p95 | >2 seconds for 10 minutes | investigate dependency/DO pressure |
| Container header/start timeout | any event in 5 minutes | page; inspect Container allocation and upstream health |
| Container p95 start wait | >5 seconds for 10 minutes | investigate cold starts/capacity |
| Queue max lag | >60 seconds for 10 minutes | page for blocked consumer |
| Queue retries | >5% of batch messages for 10 minutes | investigate transient dependency |
| Application quarantine or broker DLQ depth | any new item | page and classify before replay |
| `queue_dlq_risk` | any event | critical: quarantine path itself is unavailable |
| DO capacity | `gte_80pct` for 10 minutes | investigate; raise limits only with load evidence |
| DO saturation or eviction | any forced event | page; preserve recovery and privacy semantics |
| Connector offline transitions | >5 in 10 minutes or >2x the prior-hour baseline | investigate cloud/network regression |
| Rollout degraded/failure | any event | pause rollout and follow rollback policy |

## Staging qualification

After explicit deployment authorization:

1. Run the repository staging release preflight. Confirm both Wrangler dry-runs show the expected
   `TELEMETRY` Analytics Engine binding and the configured observability sampling.
2. Exercise health, one authenticated console request, one connector connect/disconnect/reconnect,
   one connector request/result long poll, one subscription, one scheduled batch, a controlled retry,
   a controlled quarantine, and a rollout reconciliation. Do not inject real user content.
3. Query both staging datasets and confirm every expected fixed event class appears. Review returned
   columns and Workers Logs/trace fields for paths, query strings, identifiers, content, and secrets.
   Any occurrence is a release blocker.
4. Correlate application quarantine/DLQ-risk with Cloudflare's native Queue retry, lag, and DLQ depth.
5. Force a Container sleep/restart only through the approved staging procedure; record warm and cold
   startup/header timing separately. The code's startup candidate bucket alone is not cold-start proof.
6. Run the CG-12 staged load/soak and failure drills. Save redacted query results, dashboard/alert
   configuration references, workload, time window, deployed commit/version hashes, and operator
   outcome in the release evidence location.

Until those steps are observed, the valid claim is: telemetry code, bindings, sampling, queries,
thresholds, and hermetic tests are locally ready; hosted ingestion, alert delivery, Queue/DLQ state,
Container cold-start behavior, and production cost remain unverified.
