import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REQUIRED_LAZY_FEATURES,
  analyzeFrontendBuild,
  assertFrontendPerformance,
} from "../scripts/check-frontend-performance.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "next-coder-frontend-budget-"));
  mkdirSync(join(directory, "assets"));
  const write = (file, bytes = 32) => {
    writeFileSync(join(directory, "assets", file), Buffer.alloc(bytes, 97));
    return `assets/${file}`;
  };
  const manifest = {
    "index.html": {
      file: write("index.js", 100),
      isEntry: true,
      imports: ["_shared.js"],
      css: [write("index.css", 40)],
    },
    "_shared.js": { file: write("shared.js", 50) },
  };
  for (const name of REQUIRED_LAZY_FEATURES) {
    manifest[`src/features/${name}.tsx`] = {
      file: write(`${name}.js`, 25),
      name,
      isDynamicEntry: true,
    };
  }
  return { directory, manifest };
}

test("frontend budget analysis follows only the entry's static graph", (context) => {
  const { directory, manifest } = fixture();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const report = analyzeFrontendBuild({ distDirectory: directory, manifest });

  assert.equal(report.initialJavaScript.length, 2);
  assert.equal(report.initialJavaScriptRawBytes, 150);
  assert.equal(report.dynamicFeatures.length, REQUIRED_LAZY_FEATURES.length);
  assert.doesNotThrow(() => assertFrontendPerformance(report));
});

test("frontend budget fails closed when a required feature becomes eager", (context) => {
  const { directory, manifest } = fixture();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  delete manifest["src/features/DevicesPage.tsx"];
  const report = analyzeFrontendBuild({ distDirectory: directory, manifest });

  assert.throws(
    () => assertFrontendPerformance(report),
    /DevicesPage is no longer a lazy feature chunk/u,
  );
});

test("frontend budget reports a transfer regression with measured bytes", (context) => {
  const { directory, manifest } = fixture();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const report = analyzeFrontendBuild({ distDirectory: directory, manifest });

  assert.throws(
    () => assertFrontendPerformance(report, {
      initialJavaScriptRawBytes: 149,
      initialJavaScriptGzipBytes: Number.MAX_SAFE_INTEGER,
      initialJavaScriptRequests: Number.MAX_SAFE_INTEGER,
      initialCssGzipBytes: Number.MAX_SAFE_INTEGER,
      largestFeatureChunkGzipBytes: Number.MAX_SAFE_INTEGER,
      largestFeatureRouteGzipBytes: Number.MAX_SAFE_INTEGER,
      largestFeatureRouteRequests: Number.MAX_SAFE_INTEGER,
    }),
    /initial JavaScript raw 150 > 149/u,
  );
});
