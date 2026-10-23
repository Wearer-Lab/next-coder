# Protected npm connector release

`.github/workflows/npm-connector-release.yml` is the only repository automation authorized to
publish `@wearer-haitch/connector`. It is manual-only, publishes one exact stable version from
one annotated `connector-vVERSION` tag, and enters the protected `npm-release` GitHub environment
before receiving `id-token: write`. It never reads an npm token.

The workflow exists, but no publication has been executed or verified from this checkout. Steps 1
and 2 of the one-time setup below are now complete; steps 3 to 5 are npm and GitHub account
operations that remain outstanding.

## One-time setup outside the repository

Before the first release:

1. **Done on 2026-09-08.** The repository and package license is Apache-2.0: the text is at the root
   `LICENSE` and at `packages/connector/LICENSE`, the connector manifest declares
   `"license": "Apache-2.0"`, and `LICENSE` is in its `files` allowlist. The release helper refuses
   an unresolved license or a tarball without that file, and now passes. The maintainer should still
   ratify Apache-2.0 as the deliberate choice before the repository is made public; automation
   selected a defensible default, not a legal decision.
2. **Done on 2026-09-08.** `packages/connector/package.json` carries `repository` metadata whose
   `url` names `https://github.com/spyhack225/next-coder` with `directory`
   `packages/connector`, plus matching `homepage` and `bugs`. The workflow derives the expected URL
   from `GITHUB_SERVER_URL` and `GITHUB_REPOSITORY` and compares; it never rewrites package metadata
   after checkout. If the package is ever published from a different repository, update the manifest
   first or validation fails closed.
3. In npm package settings, configure a GitHub Actions trusted publisher for the exact repository,
   workflow filename `npm-connector-release.yml`, and environment `npm-release`. That configuration
   also carries an **allowed actions** setting that names which commands the publisher may run, and
   at least one must be selected. npm sets configurations created after 3 September 2026 to allow
   `npm stage publish` automatically; permitting direct `npm publish` is a separate choice the
   maintainer must also make. This workflow runs `npm publish`, so that action must be explicitly
   allowed or the registry rejects the publication step after environment approval, with nothing
   published. Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or an npm auth token to GitHub.
4. Configure the GitHub `npm-release` environment with required reviewers and
   administrator bypass, and restrict deployment to the default branch. Protect
   `connector-v*` tags against update and deletion.
5. After trusted publishing works, disable token-based publishing for the npm package and revoke old
   automation tokens. Keep interactive npm owner recovery separate from Actions.

**Reviewer policy.** "Prevent self-review" is optional and defaults to off, so a solo maintainer can
be the sole required reviewer here and approve their own dispatch; the run still halts and waits for
a deliberate click. Note also that when several reviewers are listed, GitHub proceeds once *one* of
them approves, so extra names do not create two-person control. See
[operator-setup.md](operator-setup.md) for the settings this project actually uses.

npm trusted publishing currently requires GitHub-hosted runners, Node 22.14 or newer, and npm
11.5.1 or newer. The workflow pins Node 22.21.1 and npm 11.5.1 and gives OIDC permission only to the
publication job. Trusted publishing automatically creates provenance for a public package in a
public repository; the workflow also passes `--provenance` so disabling it is never accidental. See
the official [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[provenance](https://docs.npmjs.com/generating-provenance-statements/) documentation.

This workflow does not implement npm's [staged publishing](https://docs.npmjs.com/staged-publishing/).
Under staged publishing a maintainer must approve each submission with 2FA before the version becomes
publicly resolvable, and an OIDC token from trusted publishing deliberately cannot perform that
approval. The `verify-published` job resolves the exact version from the public registry within a
bounded retry, so a staged-but-unapproved version would be reported as a failed run even though the
publication itself succeeded — and the version number is consumed either way, because npm versions
are immutable. Adopting staged publishing therefore means changing the publication command and
splitting registry verification into a job dispatched after approval; it is not a configuration-only
switch, and `npm stage publish` needs npm 11.15.0 or later rather than the 11.5.1 client pinned here.

The first package registration and trusted-publisher association are npm account operations. If npm
does not allow the trusted publisher to be attached before the first version exists, an npm owner
must perform a separately reviewed bootstrap under npm's current policy. Do not add a long-lived
token to this workflow as a shortcut.

## Candidate preparation

1. Fix every failing merge and release gate, especially `npm run security:repo`.
2. Set one new stable version in `packages/connector/package.json`. Versions with a prerelease suffix
   are intentionally refused by this workflow.
3. Ensure the candidate is on the default branch, then create an annotated, protected tag that
   matches the version exactly:

   ```bash
   git tag -a connector-v0.1.0 TARGET_COMMIT -m 'Connector 0.1.0'
   git push origin connector-v0.1.0
   ```

   A signed annotated tag is preferable once the repository has an explicit trusted signer policy.
   The current workflow proves that the tag is annotated and resolves to the authorized commit; it
   does not claim signature verification without a configured trusted-key set.
4. Run the local gates without registry mutation:

   ```bash
   npm run security:repo
   npm run test:connector
   npm run pack:connector
   npm run test:npm-connector-release
   ```

The protected helper additionally enforces the exact package name, version, executable, Node engine,
public publish configuration, selected license and packaged `LICENSE`, repository identity,
dependency-free manifest, absence of publication lifecycle scripts, a 64-file/1 MiB compressed/2 MiB
unpacked bound, and the `bin`/`src`/README/LICENSE allowlist. It runs connector tests, packs,
installs with scripts disabled in a clean temporary directory, exercises the installed CLI, and runs
`npm publish --dry-run`.

## Authorization and publication

Dispatch **npm connector release** from the default branch with:

- `version`: exact `X.Y.Z` from the package manifest;
- `release_tag`: exact `connector-vX.Y.Z` annotated tag;
- `target_commit_sha`: exact lowercase 40-character tagged commit;
- `confirmation`: `publish:@wearer-haitch/connector@X.Y.Z:TAG:COMMIT`.

The credential-free verification job checks the default-branch ancestry, tag object and target,
authorization, repository secret gate, package tests, clean install, contents, and npm dry-run, then
uploads the exact tarball plus its hash-bound evidence for one day. The publication job downloads
and revalidates that artifact after environment approval; it does not execute candidate tests,
install the candidate, or run the candidate CLI while OIDC is available. It then makes one public
registry read: an existing name/version is an immutable refusal; a registry outage or ambiguous
error also fails closed.

The publication command uses the exact tested tarball, public access, the `latest` dist-tag, disabled
package scripts, OIDC trusted publishing, and provenance. It writes a redacted one-day publication
checkpoint. A separate credential-free job—with no `id-token` permission—then performs bounded
registry-propagation retry, digest comparison, and `npm exec` of the exact version from a fresh
directory and cache. This is clean external package evidence, not macOS/Linux/Windows service,
native credential-store, live T3, or sleep/reconnect proof.

The uploaded JSON evidence contains only the package/version, release tag, source and automation
commits, tarball filename and hashes, sizes/count, named check results, and the registry integrity
projection. It deliberately excludes actor details, npm output, registry URLs, maintainer contacts,
tokens, paths, connector state, and provider/user data. If publication succeeds but later
verification fails, inspect npm before doing anything else; never retry the same version blindly.

## Rollback, deprecation, and removal limits

npm versions are immutable. Even an unpublished name/version cannot be reused. This workflow does
not run `npm unpublish`, `npm deprecate`, or `npm dist-tag`, because trusted-publishing OIDC is scoped
to publish and those mutations have different npm authority and incident semantics. See npm's
[publish immutability contract](https://docs.npmjs.com/cli/commands/npm-publish/).

- Correct a bad package by publishing a new version. Do not rebuild the old version.
- Connector hosts can explicitly select a previously published exact version with the existing
  local `update --apply --version VERSION` flow. The cloud never invokes that command remotely.
- Moving `latest`, deprecating a bad version, or an exceptional unpublish is a separately authorized
  npm-owner incident action. Record the actor, reason, affected versions, registry result, and user
  communication outside this workflow without copying tokens or private npm output into the repo.
- npm has no general-purpose reversible “yank” in this workflow. Unpublish eligibility is governed by
  npm's current policy, and removal still does not restore the version for reuse.

Publication is one artifact gate, not rollout completion. Start with an internal connector cohort,
observe exact version and health, and follow [release-rollouts.md](release-rollouts.md).
