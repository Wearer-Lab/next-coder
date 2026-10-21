import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import type { DeviceProfile } from "../types";
import { ProfilePicker, diffCapabilities } from "./ProfilePicker";

const profiles: DeviceProfile[] = [
  {
    id: "next-coder",
    label: "Next Coder",
    description: "Full remote agent control.",
    capabilities: ["status", "agent_prompt", "shell_input"],
  },
  {
    id: "read-only",
    label: "Read only",
    description: "Status inspection only.",
    capabilities: ["status"],
  },
];

test("shows what each profile grants before it is assigned", () => {
  render(
    <ProfilePicker
      name="test-profile"
      legend="Policy profile"
      profiles={profiles}
      value="read-only"
      onChange={vi.fn()}
    />,
  );

  const agentCard = screen.getByRole("radio", { name: /next coder/i });
  expect(agentCard).not.toBeChecked();
  expect(screen.getByRole("radio", { name: /read only/i })).toBeChecked();

  // The capability list is the point of the picker: it has to be readable without
  // assigning the profile first.
  expect(screen.getByText("Send agent prompts")).toBeVisible();
  expect(
    screen.getByText("Run shell commands (dangerous ones still need approval)"),
  ).toBeVisible();
  expect(screen.getAllByText("Read agent and environment status")).toHaveLength(2);
});

test("reports the selected profile back to the caller", () => {
  const onChange = vi.fn();
  render(
    <ProfilePicker
      name="test-profile"
      legend="Policy profile"
      profiles={profiles}
      value="read-only"
      onChange={onChange}
    />,
  );

  fireEvent.click(screen.getByRole("radio", { name: /next coder/i }));

  expect(onChange).toHaveBeenCalledWith("next-coder");
});

test("warns which capabilities a reassignment revokes", () => {
  render(
    <ProfilePicker
      name="test-profile"
      legend="Policy profile"
      profiles={profiles}
      value="read-only"
      assignedProfileId="next-coder"
      onChange={vi.fn()}
    />,
  );

  expect(screen.getByText(/changes what the device may do/i)).toBeVisible();
  expect(screen.getByText("Revokes: Send agent prompts")).toBeVisible();
  expect(
    screen.getByText("Revokes: Run shell commands (dangerous ones still need approval)"),
  ).toBeVisible();
});

test("stays quiet when the picker still matches the assigned profile", () => {
  render(
    <ProfilePicker
      name="test-profile"
      legend="Policy profile"
      profiles={profiles}
      value="next-coder"
      assignedProfileId="next-coder"
      onChange={vi.fn()}
    />,
  );

  expect(screen.queryByText(/changes what the device may do/i)).toBeNull();
  expect(screen.getByText("assigned")).toBeVisible();
});

test("diffCapabilities separates grants from revocations", () => {
  expect(diffCapabilities(["status", "shell_input"], ["status", "agent_prompt"])).toEqual({
    granted: ["agent_prompt"],
    revoked: ["shell_input"],
  });
});
