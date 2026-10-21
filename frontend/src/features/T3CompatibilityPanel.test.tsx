import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { T3CompatibilityOverview } from "../types";
import { T3CompatibilityPanel } from "./T3CompatibilityPanel";

const overview: T3CompatibilityOverview = {
  release: {
    packageName: "t3",
    latestVersion: "0.0.29",
    latestError: null,
    minimumVersion: "0.0.28",
    maximumTestedVersion: "0.0.28",
    recommendedVersion: "0.0.28",
    status: "review_required",
    alert: "T3 Code 0.0.29 is newer than the latest version Next Coder has verified (0.0.28).",
  },
  results: [{
    environmentId: "env_1",
    environmentLabel: "Studio Mac",
    checkedAt: "2026-08-08T12:00:00.000Z",
    installedVersion: "0.0.29",
    previousVersion: "0.0.28",
    versionChanged: true,
    status: "review_required",
    compatible: false,
    breakingRisk: true,
    latestVersion: "0.0.29",
    recommendedVersion: "0.0.28",
    minimumVersion: "0.0.28",
    maximumTestedVersion: "0.0.28",
    recommendation: "Use T3 Code 0.0.28 for certified compatibility.",
    checks: [
      { id: "metadata", label: "Environment metadata", passed: true, detail: "T3 Code 0.0.29" },
      { id: "snapshot", label: "Orchestration snapshot", passed: true, detail: "Snapshot endpoint responded." },
    ],
    findings: [{
      level: "warning",
      code: "version_changed",
      message: "T3 Code changed from 0.0.28 to 0.0.29 since the previous check.",
    }],
  }],
  summary: {
    environments: 1,
    breakingRisks: 1,
    incompatible: 0,
    reviewRequired: 1,
    updatesRecommended: 0,
    unchecked: 0,
    needsAttention: true,
  },
};

function controller() {
  return {
    environments: [{ id: "env_1", label: "Studio Mac" }],
    busyAction: null,
    setNotice: vi.fn(),
    refreshAll: vi.fn(),
    api: vi.fn(async () => overview),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
  } as unknown as Controller;
}

test("shows installed, latest, and recommended T3 Code versions with a breaking-change alert", async () => {
  render(<T3CompatibilityPanel controller={controller()} />);

  expect(await screen.findByText("Installed: 0.0.29")).toBeVisible();
  expect(screen.getByText("New T3 Code release needs review")).toBeVisible();
  expect(screen.getByText(/changed from 0\.0\.28 to 0\.0\.29/u)).toBeVisible();
  expect(screen.getByText("npm install --global t3@0.0.28")).toBeVisible();
  expect(screen.getByRole("button", { name: /Run compatibility checks/u })).toBeEnabled();
});

test("runs a fresh read-only compatibility check", async () => {
  const c = controller();
  render(<T3CompatibilityPanel controller={c} />);
  await screen.findByText("Installed: 0.0.29");

  fireEvent.click(screen.getByRole("button", { name: /Run compatibility checks/u }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/settings/t3-compatibility", {
    method: "POST",
    body: {},
  }));
  expect(c.refreshAll).toHaveBeenCalled();
});
