# Final end-to-end qualification evidence

Next Coder is complete only after one candidate has passed every external gate in the same
cloud/connector/T3/controller journey. Local tests, a Worker dry-run, an npm tarball, or a firmware
compile cannot close that claim individually.

`scripts/verify-final-qualification.mjs` validates a flat, secret-free evidence directory after the
real exercises have run. It never performs a deployment, publishes a package, calls T3, or operates
hardware. It only proves that reviewed records are fresh, hash-linked, complete, and bound to one
40-character source commit.

It anchors the candidate to real code. The manifest's `targetCommit` must be a commit the checkout
actually contains and an ancestor of `HEAD`; a well-formed but fictional id fails with
`manifest_commit_unknown`, and one from another line of development with
`manifest_commit_not_in_checkout`. Before 2026-09-09 only the 40-character format was checked, which
let a fully-filled bundle name a commit that had never existed. Run it from the exact release
checkout:

```bash
npm run verify:final-qualification -- /path/to/evidence/final-qualification-manifest.json
```

The manifest uses `next-coder.final-qualification-manifest.v1`:

```json
{
  "schema": "next-coder.final-qualification-manifest.v1",
  "targetCommit": "<40-character lowercase commit>",
  "createdAt": "<ISO-8601 timestamp>",
  "evidence": {
    "repositorySecurity": { "file": "repository-security.json", "sha256": "<SHA-256>" },
    "npmRelease": { "file": "npm-release.json", "sha256": "<SHA-256>" },
    "cloudPromotion": { "file": "cloud-promotion.json", "sha256": "<SHA-256>" },
    "productJourney": { "file": "product-journey.json", "sha256": "<SHA-256>" },
    "resilience": { "file": "resilience.json", "sha256": "<SHA-256>" },
    "controllerHardware": { "file": "controller-hardware.json", "sha256": "<SHA-256>" },
    "operations": { "file": "operations.json", "sha256": "<SHA-256>" },
    "performance": { "file": "performance.json", "sha256": "<SHA-256>" },
    "rollback": { "file": "rollback.json", "sha256": "<SHA-256>" }
  }
}
```

Each referenced document has exactly five top-level fields:

```json
{
  "schema": "<surface schema from the verifier>",
  "result": "passed",
  "targetCommit": "<same candidate commit>",
  "finishedAt": "<ISO-8601 timestamp>",
  "checks": { "<required check>": "passed" }
}
```

The verifier exports `REQUIRED_FINAL_EVIDENCE`; its keys and check names are the executable
contract. The nine records cover credential-safe repository state and rotations, published npm
provenance plus clean macOS/Linux/Windows operation, deployed cloud resources, the complete live-T3
product journey, sleep/WAN/rollover replay, controller TLS and rollback on hardware, hosted
observability/privacy, capacity/cost/browser/firmware performance, and recovery of every released
surface.

All files must be regular flat `.json` files no larger than 256 KiB. Symlinks, path traversal,
unknown fields, reused files, missing checks, non-passing results, hash mismatches, commit mismatches,
future timestamps, and evidence older than fourteen days fail closed. Evidence records deliberately
accept no free-form logs, prompts, transcripts, paths, resource identifiers, or secrets. Keep the
underlying detailed artifacts in their protected systems and record only the pass/fail projection
required here.

This verifier makes the final claim auditable; it does not manufacture proof. Every record is an
operator attestation, and the verifier proves those attestations are complete, fresh, hash-linked
and bound to a commit in this checkout, never that the exercises behind them happened. An operator
must still perform every exercise named in the active roadmap and independently review the exact
manifest hash, and the person who reviews a bundle should not be the person who assembled it.
