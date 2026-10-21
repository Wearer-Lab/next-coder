import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  CONNECTOR_BIN_NAME,
  CONNECTOR_PACKAGE_NAME,
  ConnectorReleaseError,
  expectedReleaseConfirmation,
  normalizeNpmPublishResult,
  sanitizeRegistryMetadata,
  validatePackMetadata,
  validatePackageManifest,
  validateReleaseAuthorization,
} from "../scripts/connector-npm-release.mjs";

const workflowUrl = new URL("../.github/workflows/npm-connector-release.yml", import.meta.url);
const commit = "0123456789abcdef0123456789abcdef01234567";
const version = "0.1.0";
const tag = `connector-v${version}`;

function workflowJobs(workflow) {
  const jobsOffset = workflow.indexOf("\njobs:\n");
  assert.notEqual(jobsOffset, -1);
  const source = workflow.slice(jobsOffset + 1);
  const matches = [...source.matchAll(/^  ([a-z0-9-]+):\n/gmu)];
  return new Map(matches.map((match, index) => [
    match[1],
    source.slice(match.index, matches[index + 1]?.index ?? source.length),
  ]));
}

function authorization(overrides = {}) {
  return {
    version,
    tag,
    commit,
    confirmation: expectedReleaseConfirmation({ version, tag, commit }),
    checkedOutCommit: commit,
    tagCommit: commit,
    automationCommit: "89abcdef0123456789abcdef0123456789abcdef",
    dispatchRef: "main",
    defaultBranch: "main",
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    name: CONNECTOR_PACKAGE_NAME,
    version,
    type: "module",
    bin: { [CONNECTOR_BIN_NAME]: "./bin/next-coder-connect.mjs" },
    files: ["bin", "src", "README.md", "LICENSE"],
    license: "MIT",
    engines: { node: ">=22" },
    scripts: { test: "node --test test/*.test.mjs", "pack:smoke": "node scripts/pack-smoke.mjs" },
    publishConfig: { access: "public" },
    repository: {
      type: "git",
      url: "git+https://github.com/example/next-coder.git",
      directory: "packages/connector",
    },
    ...overrides,
  };
}

function packed(overrides = {}) {
  return {
    name: CONNECTOR_PACKAGE_NAME,
    version,
    filename: `next-coder-connector-${version}.tgz`,
    size: 50_000,
    unpackedSize: 200_000,
    integrity: "sha512-example",
    shasum: "deadbeef",
    files: [
      { path: "LICENSE", mode: 0o644 },
      { path: "README.md", mode: 0o644 },
      { path: "package.json", mode: 0o644 },
      { path: "bin/next-coder-connect.mjs", mode: 0o755 },
      { path: "src/index.mjs", mode: 0o644 },
    ],
    ...overrides,
  };
}

describe("connector npm release authorization", () => {
  it("binds one stable version, annotated tag, source commit, and explicit confirmation", () => {
    assert.deepEqual(validateReleaseAuthorization(authorization()), {
      version,
      tag,
      commit,
      automationCommit: authorization().automationCommit,
      confirmation: "validated",
    });
    for (const invalid of [
      { version: "0.1.0-beta.1" },
      { tag: "v0.1.0" },
      { commit: "short" },
      { confirmation: "publish" },
      { checkedOutCommit: "f".repeat(40) },
      { tagCommit: "f".repeat(40) },
      { dispatchRef: "feature" },
    ]) {
      assert.throws(() => validateReleaseAuthorization(authorization(invalid)), ConnectorReleaseError);
    }
  });

  it("requires the exact public, dependency-free package and provenance repository identity", () => {
    const context = {
      version,
      githubRepository: "example/next-coder",
      githubServerUrl: "https://github.com",
    };
    assert.equal(validatePackageManifest(manifest(), context).name, CONNECTOR_PACKAGE_NAME);

    assert.throws(
      () => validatePackageManifest(manifest({ license: "UNLICENSED" }), context),
      { code: "package_license_unresolved" },
    );
    assert.throws(
      () => validatePackageManifest(manifest({ repository: undefined }), context),
      { code: "package_repository_invalid" },
    );

    for (const invalid of [
      { name: "connector" },
      { version: "0.2.0" },
      { private: true },
      { license: null },
      { dependencies: { ws: "1.0.0" } },
      { scripts: { prepublishOnly: "do-something" } },
      { repository: { url: "https://github.com/another/repository.git", directory: "packages/connector" } },
      { repository: { url: "https://github.com/example/next-coder.git", directory: "connector" } },
    ]) {
      assert.throws(() => validatePackageManifest(manifest(invalid), context), ConnectorReleaseError);
    }
  });

  it("bounds the tarball, enforces its executable and allowlist, and binds registry digests", () => {
    assert.equal(validatePackMetadata(packed(), { version }).files.length, 5);
    assert.throws(() => validatePackMetadata(packed({ size: 2 * 1024 * 1024 }), { version }), ConnectorReleaseError);
    assert.throws(() => validatePackMetadata(packed({
      files: packed().files.filter((file) => file.path !== "LICENSE"),
    }), { version }), { code: "pack_required_file_missing" });
    assert.throws(() => validatePackMetadata(packed({ files: [...packed().files, { path: ".env", mode: 0o600 }] }), { version }), ConnectorReleaseError);
    assert.throws(() => validatePackMetadata(packed({
      files: packed().files.map((file) => file.path.startsWith("bin/") ? { ...file, mode: 0o644 } : file),
    }), { version }), ConnectorReleaseError);
    assert.equal(normalizeNpmPublishResult({ [CONNECTOR_PACKAGE_NAME]: packed() }).name, CONNECTOR_PACKAGE_NAME);

    assert.deepEqual(sanitizeRegistryMetadata({
      name: CONNECTOR_PACKAGE_NAME,
      version,
      dist: { integrity: "sha512-example", shasum: "deadbeef", tarball: "https://registry.example/private" },
      maintainers: [{ email: "private@example.com" }],
    }, { version, integrity: "sha512-example", shasum: "deadbeef" }), {
      name: CONNECTOR_PACKAGE_NAME,
      version,
      integrity: "sha512-example",
      shasum: "deadbeef",
    });
  });
});

describe("protected npm connector workflow", () => {
  it("is manual-only, pins actions, and grants OIDC only to the protected publication job", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
    assert.doesNotMatch(workflow, /^  (?:push|pull_request|release):/mu);
    assert.match(workflow, /^permissions:\n  contents: read$/mu);
    assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./u);

    const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)].map((match) => match[1]);
    assert.ok(uses.length > 0);
    for (const action of uses) assert.match(action, /^[^@\s]+@[a-f0-9]{40}$/u);
    const checkouts = [...workflow.matchAll(/uses:\s+actions\/checkout@[a-f0-9]{40}/gu)];
    const nonPersisted = [...workflow.matchAll(/^\s+persist-credentials:\s+false$/gmu)];
    assert.equal(checkouts.length, nonPersisted.length);

    const jobs = workflowJobs(workflow);
    const verification = jobs.get("verify-candidate");
    const publication = jobs.get("publish");
    const externalVerification = jobs.get("verify-published");
    assert.ok(verification && publication && externalVerification);
    assert.match(verification, /run: npm run check:docs/u);
    assert.doesNotMatch(verification, /id-token:\s*write/u);
    assert.doesNotMatch(verification, /^    environment:/mu);
    assert.match(publication, /^    environment:\n      name: npm-release$/mu);
    assert.match(publication, /^      id-token: write$/mu);
    assert.equal([...workflow.matchAll(/id-token:\s*write/gu)].length, 1);
    assert.doesNotMatch(externalVerification, /id-token:\s*write/u);
    assert.match(publication, /npm publish "\$TARBALL_PATH" --access public --provenance --tag latest --ignore-scripts --json/u);
    assert.match(publication, /connector-npm-release\.mjs verify-artifact/u);
    assert.doesNotMatch(publication, /connector-npm-release\.mjs prepare|npm test|npm exec/u);
    assert.match(externalVerification, /npm exec --yes --package="\$PACKAGE_SPEC" -- next-coder-connect update/u);
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/u);
  });

  it("rechecks immutable identity, verifies through a clean exact-version npm exec, and uploads redacted evidence", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    assert.match(workflow, /npm view "\$PACKAGE_SPEC" version --json/u);
    assert.match(workflow, /That npm package version already exists and cannot be reused/u);
    assert.match(workflow, /npm exec --yes --package="\$PACKAGE_SPEC" -- next-coder-connect update/u);
    assert.match(workflow, /connector-npm-release\.mjs finalize/u);
    assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/u);
    assert.match(workflow, /retention-days: 90/u);
    assert.doesNotMatch(workflow, /npm (?:unpublish|deprecate|dist-tag)/u);
  });
});
