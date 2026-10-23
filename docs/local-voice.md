# Voice notes through the local connector

Next Coder routes controller recordings to the computer paired with their captured T3 environment.
The connector transcribes them locally with Parakeet and returns text to the gateway. The gateway
applies transcript review, the device's current voice auto-send grant, and policy before submitting
one T3 command. T3 replies return through the connector and the device's existing output feed.
Cloudflare routes and stores control-plane work; it does not run speech inference.

## Account and environment isolation

The recording's owner, device, environment, and thread are captured when the upload is queued.
Changing a device's selected thread later does not redirect a pending recording. A connector may
retrieve only audio for its own environment and account while the matching transcription job has an
active lease. Revocation and environment replacement are checked again after storage access and
before a returned transcript is used. A different user's connector cannot fetch the recording.

Only opaque job/media identifiers travel in the connector request. Audio is downloaded through an
authenticated HTTPS endpoint on the paired gateway origin, with no bearer credential in its URL,
no arbitrary download address, and no public laptop port. Download size, response size, inference
time, local concurrency, and retries are bounded. Audio is not placed in WebSocket frames.

## Local runtime

The connector package contains the model downloader and Python sidecar. It manages a private Python
environment and model directory beneath its own configuration directory, independent of the project
checkout and system Python. Runtime downloads use a pinned uv release with reviewed archive SHA-256
digests. Model downloads are resumable and verified at a pinned model revision. The local sidecar
binds to loopback; it receives no connector, cloud, or coding-provider credentials.

First setup needs internet access and space for Python, inference dependencies, and approximately
660 MB of model files. Subsequent inference runs locally. A healthy existing compatible sidecar can
be reused; the connector stops or restarts only a sidecar process it owns. Setup and recovery must
report a failure rather than advertise a capability that is not ready.

The bundled `nvidia/parakeet-tdt-0.6b-v2` checkpoint is **English only**. Other languages must be
rejected explicitly rather than silently treated as English. Generic file upload or a model's audio
schema does not establish that the T3 provider adapter accepts native audio.

## Delivery and recovery

An upload acknowledgement is not a transcript or a completed agent turn. The durable media job
records transcription, normalization, review, dispatch, and failure separately. Queue wakeups start
new work promptly; the scheduled recovery sweep remains a fallback. A busy runner retries its
wakeup rather than acknowledging another user's unprocessed recording.

A stable command request identity derived from the media job prevents a replay after dispatch from
creating a second agent turn. Transcription retries do not authorize dispatch by themselves.
Historical failed recordings are not automatically replayed after setup; explicit configuration
retry requires transcript review.

The computer must be running and connected for local transcription and T3 execution. If it is
unavailable, the application must expose retry/recovery state; it cannot truthfully report success.
Do not expose the local sidecar to the internet as an outage workaround.

## Distribution and verification

The source and a packed connector can be installed without a repository checkout. Public
`npx @next-coder/connector` distribution additionally requires the protected npm publication flow in
[npm-connector-release.md](npm-connector-release.md). Do not claim registry availability based only
on a local package test.

Code/contract tests, clean installation, local inference, production routing, physical microphone
capture, T3 completion, and visible device reply are separate verification steps. A generated clip
is useful for inference preflight but does not prove the Hosyond microphone or display path.

## Model attribution

Parakeet TDT 0.6B v2 is an NVIDIA model distributed under **CC BY 4.0**. The connector uses
[Istupakov's ONNX conversion](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx), revision
`0bbb45a3365852604aef28b538a8f066f4ccaa85`, with int8 quantized inference. See the
[original NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) and
[CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/). These model terms are separate
from the connector's Apache-2.0 source license.

## Connector commands

Normal `next-coder-connect connect` prepares and maintains voice automatically, including when run
as the per-user managed connector service. For explicit inspection or repair:

```bash
next-coder-connect voice status --json
next-coder-connect voice setup
next-coder-connect restart
```

Use the same `--state-dir` as the enrolled connector when overriding the default configuration
location. Setup prepares files; the running connector owns the inference process and its recovery.
The first download is part of onboarding and must finish before the connector advertises voice
readiness. An interrupted setup can be retried; no model file is trusted until verification passes.
