# T3 capability manifest

Next Coder exposes a versioned, read-only capability projection at
`GET /v1/t3/environments/:id/capabilities`. It is built by `T3Adapter`, the single application
boundary over both direct and outbound-connector transports. Application code calls the same
`environmentInfo`, `snapshot`, `threadDetail`, `dispatch`, `callRpc`, `openThreadStream`, and
`capabilities` methods regardless of transport.

The current schema is `next-coder.t3-capabilities.v1` with adapter contract
`t3-adapter.v1`. Discovery reads environment metadata, the orchestration snapshot, and
`server.getConfig`; when a thread exists it performs one bounded thread-detail read. The connector
performs the same probe locally and returns only contract booleans, probe outcomes, and the reported
semantic version—never project/thread IDs, paths, provider details, prompts, or transcripts.

Features are not inferred from the T3 version. Each feature is `supported`, `unsupported`, or
`unknown`, with bounded evidence naming the successful response, server-advertised flag, scope, or
adapter method. A newer version does not automatically enable a new field. An absent or malformed
response fails closed and carries a recovery action used by the console and compact device health.

T3 0.0.32's shipped source map certifies:

- image attachments only, at most 8 and 10 MiB each; audio and generic file attachments remain off;
- four runtime modes and `default|plan` interaction modes;
- `accept`, `acceptForSession`, `decline`, and `cancel` approval decisions;
- structured user-input response, turn interruption, session stop, proposed plans, checkpoints, and
  task lifecycle projection;
- thread-detail pagination and resumable thread subscription flags in `server.getConfig`.

It does not certify stable per-task input, stop, or resume commands. The manifest deliberately has
no such feature keys, and the UI/device must not synthesize those controls from task lifecycle rows.

Fresh results are cached for five minutes per environment. A cache hit is labeled `source: cache`;
if refresh fails, an existing result may be returned only as `freshness: stale` with explicit
recovery. Compatibility checks persist the owner-safe manifest alongside their result. Device
projection receives only `ready|limited|unknown|stale|incompatible` plus a bounded action, not the
full owner manifest.

Captured contract evidence lives in `test/fixtures/t3-capability-probe-0.0.32.json`. It contains no
live user data. Compatibility tests cover missing, malformed, and newer/unknown capabilities and
assert that unsupported attachment types and nonexistent per-task controls stay disabled.
