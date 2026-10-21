# Deferred items

Known work that is real but not blocking, recorded here so it stays visible instead of stalling
something else. Nothing in this file prevents development, staging deployment, qualification, or the
connector release. Each row says plainly what the risk is today and what event makes it urgent.

The ordered plan for finishing the product is [../roadmap/completion-plan.md](../roadmap/completion-plan.md);
this file is only for things deliberately postponed.

## Security follow-ups

### 1. Rotate the previously exposed Convex gateway secret

**Status:** open. **Urgent when:** a Convex deployment holds real data, so before completion plan
Phase 1.3.

`GATEWAY_CONVEX_SECRET` authenticates every gateway-to-Convex call. A value was exposed previously,
and gap register row CG-10 has recorded it as needing external rotation since 2026-08-27.

It is not urgent today because no Convex deployment exists yet and nothing is deployed. It becomes
urgent the moment a real staging or production deployment exists, because the exposed value would
then authenticate against live data. Rotate it as part of generating the runtime secrets rather than
as a separate errand: the shared value must be entered identically in the Cloudflare Worker secret
and the Convex environment, and neither provider lets you read a stored value back to compare, so
the provisioning record is the only evidence they match. See
[operator-setup.md](operator-setup.md) stage 2.

### 2. Rotate the bench device secret and Wi-Fi password, then delete the backup mirror

**Status:** open. **Urgent when:** the mirror leaves this machine, or the bench device is used
against a deployed gateway.

A tracked firmware config once carried a real device secret and a home Wi-Fi password. Both were
purged from history on 2026-09-08 **before** the first push, so neither has ever existed on GitHub,
and `npm run security:repo` passes over the tracked tree.

The remaining copy is local only:

```
~/Documents/Claude/Projects/next-coder-pre-oss-backup.git
```

That mirror is the pre-rewrite history, kept deliberately as a safety net in case the rewrite lost
something. Nothing now depends on it. Rotate the Wi-Fi password and re-provision the bench device
with a fresh secret, then delete the mirror; until then, treat that directory as credential-bearing
and do not copy, sync, or back it up.

Order matters only in one direction: deleting the mirror before rotating removes the record of what
was exposed, so rotate first.

## Repository and tooling

### 3. Line anchors in documentation rot silently

**Status:** open. **Urgent when:** never, but it recurs.

`npm run check:docs` validates that a relative link's *path* resolves. It does not validate `#L`
line anchors, so a link to a specific line keeps passing after the code around it moves. A 2026-09-09
audit fixed a batch of these in [device-setup-flow.md](device-setup-flow.md) by hand; they will drift
again. Extending the link gate to resolve line anchors against the file, or to prefer symbol names
over line numbers, would close it permanently.

### 4. `npm run test:staging-drills` is not referenced by any workflow

**Status:** open, cosmetic. **Urgent when:** never.

The four drill test files are already covered twice, by the `test/*.test.mjs` glob inside
`npm test` and by name in `npm run test:workflow`, so nothing is ungated. The alias exists for
convenience and should not be mistaken for a CI job that runs on its own.

## Environment

### 5. This checkout lives in a cloud-synced folder

**Status:** open. **Urgent when:** it already costs time on every full test run.

The working copy sits under a macOS File Provider synced directory. Three distinct symptoms trace to
it: a random subset of frontend test files times out at five seconds under load while passing when
run alone, PlatformIO firmware builds have stalled on duplicated `.pio` output directories, and an
installed `vite` package was once found hollowed out mid-run, which needed `npm ci` to repair.

None is a product defect and none has ever reproduced in CI, where every job is green. Moving the
checkout outside the synced directory, or excluding it from sync, removes all three. Until then,
treat a frontend timeout with no assertion failure as environmental and rerun before diagnosing it.
