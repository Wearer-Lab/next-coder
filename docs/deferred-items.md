# Deferred items

Known work that is real but not blocking, recorded here so it stays visible instead of stalling
something else. Each row says plainly what the risk is today and what event makes it urgent.

**Revised 2026-10-30: the two security items below are no longer deferred.** Both named an event
that would make them urgent, and both events have happened — a production origin is deployed and a
controller is operating against it. They are now overdue work, not postponed work, and the
sentence this file used to carry here — that nothing in it blocks deployment, qualification, or the
connector release — was true when written and is not true now. Items 3 to 5 remain genuinely
deferred.

The ordered plan for finishing the product is [../roadmap/completion-plan.md](../roadmap/completion-plan.md);
rows 0.2 and 2 of that plan carry the same correction.

## Security follow-ups

### 1. Rotate the previously exposed Convex gateway secret

**Status: overdue, and the only item here with a live exposure.** **Urgent since:** the production
origin began serving real data.

`GATEWAY_CONVEX_SECRET` authenticates every gateway-to-Convex call. A value was exposed previously,
and gap register row CG-10 has recorded it as needing external rotation since 2026-08-27.

This row previously read "it is not urgent today because no Convex deployment exists yet and
nothing is deployed." That condition has ended. `cloudflare-control-plane/src/runtimeConfig.ts`
forces `STORAGE_PROVIDER: "convex"` whenever cloud mode is on, so the deployed production stack
authenticates to Convex with this secret, and the October evidence in
[../roadmap/IMPLEMENTATION-STATUS.md](../roadmap/IMPLEMENTATION-STATUS.md) records real sign-ins,
commands, media jobs and device claims against it. If the exposed value is still in place, it
authenticates against live owner data today.

Two things are worth separating. Whether the deployed secret *is* the exposed value is not
recorded anywhere in this repository and neither provider lets a stored value be read back, so it
has to be established from the provisioning record or by rotating regardless — rotating is cheaper
than proving. And rotation is no longer the "do it while generating the runtime secrets" errand
this row described, because the secret is in use: the shared value must be entered identically in
the Cloudflare Worker secret and the Convex environment, and a mismatch takes the gateway's store
offline. Plan it as a short maintenance window with the provisioning record as the only evidence
the two sides match. See [operator-setup.md](operator-setup.md) stage 2.

### 2. Rotate the bench device secret and Wi-Fi password, then delete the backup mirror

**Status: overdue on the device half.** **Urgent since:** the Hosyond controller began operating
against the deployed production gateway, which is the second trigger this row named.

Two corrections, 2026-10-30. The bench device is in daily use against production — the October
evidence records claims, saved actions and voice turns from firmware 0.2.16 to 0.2.19 — so the
device half of this row has fired. Whether the unit still holds the purged secret is not recorded;
it has been re-provisioned repeatedly since, so re-provisioning with a fresh secret and confirming
it is the cheap resolution either way. Separately, the mirror is **not present at the path below**,
and nothing in this repository records it being deleted. Confirm whether it was deleted or moved
before treating this row as closed, and note the ordering rule at the end of this section: if it
was deleted before the rotation, the record of what was exposed is gone and both credentials should
be rotated on the assumption that they were.

A tracked firmware config once carried a real device secret and a home Wi-Fi password. Both were
purged from history on 2026-09-08 **before** the first push, so neither has ever existed on GitHub,
and `npm run security:repo` passes over the tracked tree.

The remaining copy was local only, at:

```
~/Documents/Claude/Projects/next-coder-pre-oss-backup.git
```

That path is empty as of 2026-10-30, so either the mirror was deleted without being recorded here
or it was moved; the owner is the only one who can say which. It held the pre-rewrite history,
kept deliberately as a safety net in case the rewrite lost something. Nothing now depends on it. Rotate the Wi-Fi password and re-provision the bench device
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
