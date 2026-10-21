# Assembling evidence bundles

Two Phase 7 gates consume a directory of hash-linked JSON records: the protected production
promotion ([production promotion](production-promotion.md)) and the final end-to-end qualification
([final qualification](final-qualification.md)). Both are assembled by hand under a clock — the
promotion manifest rejects evidence older than 72 hours, and the final verifier rejects records
older than 14 days — and both fail closed on shapes that are easy to get wrong at 2 a.m.:
an unknown field, a reused filename, a symlink, a stale timestamp, a hash that no longer matches
the bytes it names.

`scripts/make-evidence-bundle.mjs` writes the shape and maintains the hash links so the operator
spends their time on the exercises instead of on JSON.

```bash
node scripts/make-evidence-bundle.mjs init promotion ./promotion-evidence --commit <40-hex> --staging-origin https://staging.example
node scripts/make-evidence-bundle.mjs init final-qualification ./final-evidence --commit <40-hex>
node scripts/make-evidence-bundle.mjs refresh ./final-evidence   # after every edit
node scripts/make-evidence-bundle.mjs status  ./final-evidence   # read-only check
```

Exit codes: `0` the bundle is complete and its hashes match the bytes on disk, `1` placeholders
remain or the manifest is out of date, `2` usage or structural failure.

## What it will not do

The generator produces a **skeleton**, never evidence. Every value it declines to invent is listed
below. Read the limit at the end of this section first: these constraints bind *the generator*, and
that is not the same as making the pipeline unfalsifiable.

- it never writes `"passed"` — every result and every named check is a `REPLACE_ME:` token that
  the verifiers compare against `"passed"` and reject;
- it never writes a timestamp for an exercise that did not run. `finishedAt` stays a token that
  `Date.parse()` refuses, which is exactly what `manifest_stale` / `evidence_*_stale` catch;
- it never invents a commit id, a staging origin, a source-artifact digest, or a release operation.
  Those come from the operator (`--commit`, `--staging-origin`) or stay tokens;
- the only values it computes are the SHA-256 of bytes that already exist on disk, and — once no
  placeholder is left anywhere — the manifest's own assembly time, which describes its own action;
- `status` never prints a hash the manifest file does not actually have. If the records changed
  since the last `refresh`, it says so and exits non-zero instead of handing over a hash.

### The limit of that guarantee

An adversarial review on 2026-09-09 filled every placeholder with one `sed`, ran `refresh`, and got
a bundle the final-qualification verifier accepted — on a commit id that had never existed. The
generator had invented nothing; a person had, in about a minute. The honest claim is therefore
narrow: **this tool will not fabricate evidence, and it does not stop a person from doing so.**

That review closed the specific hole it found. `verifyFinalQualification()` now anchors the
manifest's `targetCommit` to the checkout it runs in, the way production promotion always anchored
its own: the commit must exist and must be an ancestor of `HEAD`, so a fictional or foreign id fails
with `manifest_commit_unknown` or `manifest_commit_not_in_checkout`. Run the verifier from the exact
release checkout, or it has nothing to anchor against.

What remains is procedural, and no script can supply it. Each of the nine records is an operator
attestation that some exercise was actually performed; the verifier proves those attestations are
complete, fresh, hash-linked and bound to real code, never that the exercises happened. Keep two
habits: the person who verifies a bundle should not be the person who filled it, and the underlying
detailed artifacts should stay in their own protected systems, with only the pass/fail projection
copied here.

[`test/evidenceBundle.test.mjs`](../test/evidenceBundle.test.mjs) is the standing guard: it
generates a bundle, asserts the repository's own verifiers **reject** it, fills the placeholders
with well-formed values, and only then asserts they accept it. If the skeleton ever became
accidentally valid, that test fails.

A skeleton is not a draft of a claim. Delete the directory rather than shipping a bundle whose
exercises did not happen.

## Promotion bundle

`init promotion` writes five files. `promotion-manifest.json` is what the dispatcher hashes:

```json
{
  "schema": "next-coder.staging-promotion-manifest.v1",
  "targetCommit": "<40-character lowercase commit>",
  "createdAt": "<ISO-8601, under 72 hours old at dispatch>",
  "artifacts": {
    "console": "<64-character SHA-256>",
    "edge": "<64-character SHA-256>",
    "controlPlane": "<64-character SHA-256>",
    "container": "<64-character SHA-256>",
    "convex": "<64-character SHA-256>"
  },
  "evidence": {
    "release": { "file": "staging-release-evidence.json", "sha256": "<SHA-256>" },
    "qualification": { "file": "staging-qualification-evidence.json", "sha256": "<SHA-256>" },
    "capacity": { "file": "staging-capacity-evidence.json", "sha256": "<SHA-256>" },
    "security": { "file": "staging-security-evidence.json", "sha256": "<SHA-256>" }
  }
}
```

Each referenced record must carry its own schema, `result: "passed"`, and a `finishedAt` under 72
hours old. Release, capacity, and security must also carry the exact `targetCommit`; qualification
must carry `target.origin` equal to the configured staging origin, and release must carry
`operation: "deploy"`. Extra fields are allowed here, which is why two of the four records are not
written by hand at all:

| File | Where the real record comes from |
| --- | --- |
| `staging-release-evidence.json` | replace wholesale with the passing artifact from `npm run staging:release` — see [staging release](staging-release.md) |
| `staging-qualification-evidence.json` | replace wholesale with the passing artifact from `npm run qualify:staging` — see [staging qualification](staging-qualification.md) |
| `staging-capacity-evidence.json` | an operator attestation written after the hosted matrix in [capacity SLO](capacity-slo.md) actually ran |
| `staging-security-evidence.json` | an operator attestation written after the drills in [production security](production-security.md) and [cloud observability](cloud-observability.md) actually ran |

Fill the five `artifacts` digests from `npm run production:artifact-digests`, run from a clean
checkout of the candidate commit. `init promotion --artifact-digests` computes them from the
current checkout instead; it prints a warning because that is only correct on the candidate. The
protected workflow recomputes them either way and refuses a mismatch.

When nothing is left to replace, `refresh` prints the dispatch confirmation string:

```text
promote:production:<target-commit>:<manifest-sha256>
```

Review the manifest bytes and that SHA-256 independently before dispatching. The generator's word
that a hash covers those bytes is not a substitute for reading them.

## Final qualification bundle

`init final-qualification` writes nine records plus `final-qualification-manifest.json`, with the
surface names, filenames, and per-surface check lists taken directly from
`REQUIRED_FINAL_EVIDENCE` in the verifier — so the skeleton cannot drift from the contract it has
to satisfy.

```json
{
  "schema": "next-coder.final-qualification-manifest.v1",
  "targetCommit": "<40-character lowercase commit>",
  "createdAt": "<ISO-8601, under 14 days old>",
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

Every record has exactly five top-level fields and no others:

```json
{
  "schema": "next-coder.final.<surface>.v1",
  "result": "passed",
  "targetCommit": "<same candidate commit>",
  "finishedAt": "<ISO-8601, under 14 days old>",
  "checks": { "<each required check>": "passed" }
}
```

Both the manifest and each record are key-exact: an added note, a removed check, or a renamed
surface fails closed. Put working notes somewhere else — the generated `REPLACE-THESE.md` in the
bundle directory holds the replacement list and is ignored by the verifier, so it can be deleted
at any time. Records accept no logs, prompts, transcripts, paths, resource identifiers, or
secrets; keep the detailed artifacts in their protected systems.

Verify with the repository's own gate, never with this generator:

```bash
npm run verify:final-qualification -- ./final-evidence/final-qualification-manifest.json
```

## Working rules

- **Files are flat and regular.** No subdirectories, no symlinks, no `..` in a filename. Promotion
  files cap at 1 MiB; final-qualification files cap at 256 KiB. `refresh` refuses a symlink, an
  oversized file, unparseable JSON, a reused filename, or (for final qualification) an unexpected
  key, so the problem surfaces before dispatch instead of during it.
- **Re-run `refresh` after every edit.** The manifest names a hash of exact bytes; an edit without a
  refresh is a `..._hash_mismatch` at the gate.
- **Do the exercises first, then the bundle.** Both clocks run from `finishedAt`, so a bundle
  assembled ahead of the work only expires sooner.
- **The verifier proves records are fresh, hash-linked, complete, and bound to one commit.** It does
  not prove the exercises happened. That remains a person's signature, and nothing in this
  repository has been deployed, published, or hardware-proven.

Phase 7 items 7.1 and 7.5 in [roadmap/completion-plan.md](../roadmap/completion-plan.md) are what
these bundles feed; [roadmap/IMPLEMENTATION-STATUS.md](../roadmap/IMPLEMENTATION-STATUS.md) records
what is actually proven.
