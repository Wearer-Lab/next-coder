import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectDocumentationFiles,
  extractDocumentationTargets,
  validateDocumentationLinks,
} from "../scripts/check-documentation-links.mjs";

test("documentation target extraction ignores code and keeps source lines", () => {
  const targets = extractDocumentationTargets([
    "[guide](docs/guide.md)",
    "`[example](missing-inline.md)`",
    "```md",
    "[fixture](missing-fence.md)",
    "```",
    "[reference]: <docs/reference file.md#section>",
    "![image](assets/device.png)",
    "[external](https://example.com)",
  ].join("\n"));

  assert.deepEqual(targets, [
    { target: "docs/guide.md", line: 1 },
    { target: "assets/device.png", line: 7 },
    { target: "https://example.com", line: 8 },
    { target: "docs/reference file.md#section", line: 6 },
  ]);
});

test("documentation validation checks decoded local targets and rejects escape or missing paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "next-coder-doc-links-"));
  t.after(async () => await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await mkdir(join(root, "docs", "assets"), { recursive: true });
  await writeFile(join(root, "README.md"), [
    "[guide](docs/guide.md#start)",
    "[encoded](docs/assets/hello%20world.txt)",
    "[missing](docs/missing.md)",
    "[escape](../private.txt)",
    "[web](https://example.com)",
    "[route](/v1/health)",
  ].join("\n"));
  await writeFile(join(root, "docs", "guide.md"), "# Start\n");
  await writeFile(join(root, "docs", "assets", "hello world.txt"), "hello\n");

  const result = await validateDocumentationLinks({ root, documents: ["README.md"] });
  assert.equal(result.documents, 1);
  assert.equal(result.links, 4);
  assert.deepEqual(result.findings, [
    { document: "README.md", line: 3, target: "docs/missing.md", reason: "missing-target" },
    { document: "README.md", line: 4, target: "../private.txt", reason: "outside-repository" },
  ]);
});

test("default documentation inventory is bounded to maintained docs and excludes vendored trees", async () => {
  const files = await collectDocumentationFiles();
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("docs/ci-release-gates.md"));
  assert.ok(files.includes("roadmap/cloud-control-plane-connector-roadmap.md"));
  assert.ok(files.includes("packages/connector/README.md"));
  assert.ok(files.includes("firmware/shared/README.md"));
  assert.equal(files.some((path) => path.includes("node_modules")), false);
  assert.equal(files.some((path) => path.startsWith("firmware/")
    && path.includes("/docs/")
    && !path.endsWith("/docs/README.md")), false);
});

test("maintained repository documentation has no missing relative target", async () => {
  const result = await validateDocumentationLinks();
  assert.deepEqual(result.findings, []);
  assert.ok(result.documents >= 30);
  assert.ok(result.links >= 100);
});
