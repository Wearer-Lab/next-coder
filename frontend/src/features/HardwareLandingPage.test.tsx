import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { AuthConfig, ClerkBridge } from "../types";
import { HardwareLandingPage } from "./HardwareLandingPage";

function clerkBridge(overrides: Partial<ClerkBridge> = {}): ClerkBridge {
  return {
    loaded: true,
    signedIn: false,
    userLabel: null,
    getToken: vi.fn(async () => null),
    openSignIn: vi.fn(),
    openSignUp: vi.fn(),
    openUserProfile: vi.fn(),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
}

const clerkEnabled: AuthConfig = { clerk: { enabled: true, publishableKey: "pk_test_x" } };

test("puts the device, its specs and what ships in the box on one screen", () => {
  render(<HardwareLandingPage authConfig={clerkEnabled} clerk={clerkBridge()} />);

  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/A knob for the agent/u);
  expect(screen.getByText("BATCH 01 · 250 UNITS")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "One EC11 encoder" })).toBeInTheDocument();
  expect(screen.getByText(/USB-C cable, signed OTA/u)).toBeInTheDocument();
});

// There is no waitlist endpoint on the gateway. Taking an address the server would drop is worse
// than saying so, so the form must stay inert until a handler is supplied.
test("does not collect an email when there is nowhere to record it", () => {
  render(<HardwareLandingPage authConfig={clerkEnabled} clerk={clerkBridge()} />);

  expect(screen.getByRole("button", { name: /Request a unit/u })).toBeDisabled();
  expect(screen.getByLabelText("Email address")).toBeDisabled();
  expect(screen.getByText(/Reservations are not open yet/u)).toBeInTheDocument();
});

test("submits and confirms once a handler is wired up", async () => {
  const onRequestUnit = vi.fn(async () => {});
  render(
    <HardwareLandingPage authConfig={clerkEnabled} clerk={clerkBridge()} onRequestUnit={onRequestUnit} />,
  );

  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "dana@studio.dev" } });
  fireEvent.click(screen.getByRole("button", { name: /Request a unit/u }));

  await waitFor(() => expect(onRequestUnit).toHaveBeenCalledWith("dana@studio.dev"));
  expect(await screen.findByText(/dana@studio.dev/u)).toBeInTheDocument();
});

test("keeps the address on screen when the request fails", async () => {
  const onRequestUnit = vi.fn(async () => {
    throw new Error("nope");
  });
  render(
    <HardwareLandingPage authConfig={clerkEnabled} clerk={clerkBridge()} onRequestUnit={onRequestUnit} />,
  );

  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "dana@studio.dev" } });
  fireEvent.click(screen.getByRole("button", { name: /Request a unit/u }));

  expect(await screen.findByText(/did not go through/u)).toBeInTheDocument();
  expect(screen.getByLabelText("Email address")).toHaveValue("dana@studio.dev");
});

test("sends someone who wants software today to the console", () => {
  const clerk = clerkBridge();
  render(<HardwareLandingPage authConfig={clerkEnabled} clerk={clerk} />);

  fireEvent.click(screen.getByRole("button", { name: /Use the console instead/u }));
  expect(clerk.openSignUp).toHaveBeenCalled();
});

// The console path on this page ends in an account, so when the gateway cannot answer, the page
// has to say so rather than pointing at a door that is not there.
test("explains a gateway that did not answer instead of implying sign-in is unconfigured", () => {
  render(
    <HardwareLandingPage
      authConfig={{ clerk: { enabled: false, publishableKey: null }, gatewayReachable: false }}
      clerk={null}
    />,
  );

  expect(screen.getByText(/gateway is not answering/u)).toBeInTheDocument();
  expect(screen.queryByText(/Sign-in is not configured/u)).not.toBeInTheDocument();
});
