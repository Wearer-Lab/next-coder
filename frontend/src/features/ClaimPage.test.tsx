import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

import { ApiError } from "../api";
import type { Controller } from "../controller";
import { ClaimPage } from "./ClaimPage";

const link = { deviceId: "dev_42", code: "ABCDE-12345" };

function controller(overrides: Record<string, unknown> = {}) {
  return {
    authenticated: true,
    clerk: null,
    api: vi.fn(async () => ({ device: { id: "dev_42", label: "Desk controller" } })),
    ...overrides,
  } as unknown as Controller;
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/claim?device=dev_42&code=ABCDE-12345");
});

test("shows the scanned code without asking the owner to retype it", () => {
  render(<ClaimPage controller={controller()} link={link} onDone={vi.fn()} />);

  expect(screen.getByLabelText("Claim code")).toHaveTextContent("ABCDE-12345");
  expect(screen.getByText(/Controller dev_42/u)).toBeInTheDocument();
});

test("claims with the scanned code and hands the device back", async () => {
  const c = controller();
  const onDone = vi.fn();
  render(<ClaimPage controller={c} link={link} onDone={onDone} />);

  fireEvent.change(screen.getByLabelText(/Name this controller/u), {
    target: { value: "Desk controller" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Claim this controller/u }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/claim", {
    method: "POST",
    body: { claimCode: "ABCDE-12345", label: "Desk controller" },
  }));
  await screen.findByText("Controller claimed");

  fireEvent.click(screen.getByRole("button", { name: /Continue setup/u }));
  expect(onDone).toHaveBeenCalledWith({ device: { id: "dev_42", label: "Desk controller" } });
});

test("a spent code is taken out of the address bar", async () => {
  render(<ClaimPage controller={controller()} link={link} onDone={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Claim this controller/u }));

  await screen.findByText("Controller claimed");
  expect(window.location.pathname).toBe("/");
  expect(window.location.search).toBe("");
  expect(sessionStorage.getItem("nextCoderClaimLink")).toBeNull();
});

// The reason the landing exists at all: a used or expired code previously surfaced as a generic
// toast on whatever page the router happened to pick.
test("an already-used or expired code gets an explicit dead-end, not a toast", async () => {
  const c = controller({
    api: vi.fn(async () => {
      throw new ApiError(404, "Claim code is invalid, expired, or already used.");
    }),
  });
  const onDone = vi.fn();
  render(<ClaimPage controller={c} link={link} onDone={onDone} />);
  fireEvent.click(screen.getByRole("button", { name: /Claim this controller/u }));

  await screen.findByText("This code cannot be used");
  expect(screen.getByText(/invalid, expired, or already used/u)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Enter a code manually/u }));
  expect(onDone).toHaveBeenCalledWith({ device: null });
});

test("a transient failure stays retryable instead of dead-ending", async () => {
  const api = vi.fn(async () => {
    throw new ApiError(503, "Gateway is restarting.");
  });
  render(<ClaimPage controller={controller({ api })} link={link} onDone={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Claim this controller/u }));

  await screen.findByText("Gateway is restarting.");
  expect(screen.queryByText("This code cannot be used")).not.toBeInTheDocument();
  const retry = screen.getByRole("button", { name: /Claim this controller/u });
  expect(retry).not.toBeDisabled();
});

test("an unauthenticated scan is sent to sign-in with the code held", () => {
  const openSignIn = vi.fn();
  render(
    <ClaimPage
      controller={controller({ authenticated: false, clerk: { openSignIn } })}
      link={link}
      onDone={vi.fn()}
    />,
  );

  expect(screen.getByLabelText("Claim code")).toHaveTextContent("ABCDE-12345");
  fireEvent.click(screen.getByRole("button", { name: /Sign in to continue/u }));
  expect(openSignIn).toHaveBeenCalled();
  // The code must still be recoverable after the auth round trip.
  expect(window.location.search).toContain("code=ABCDE-12345");
});
