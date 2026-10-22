import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { AuthConfig, ClerkBridge } from "../types";
import { DeveloperLandingPage } from "./DeveloperLandingPage";

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

test("leads with the setup command and the pipeline it kicks off", () => {
  render(<DeveloperLandingPage authConfig={clerkEnabled} clerk={clerkBridge()} />);

  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Your agent stays home/u);
  expect(screen.getByText("$ npm run setup:t3")).toBeInTheDocument();
  expect(screen.getByText(/registered environment/u)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Screen the intent against policy/u })).toBeInTheDocument();
  expect(screen.getByText("POST /v1/commands/:id/approve")).toBeInTheDocument();
});

// The point of this cut is that the account ask comes last. It is still offered twice (hero and
// closer) because a reader convinced by the transcript should not have to scroll to act.
test("offers the account CTA in both the hero and the closing section", () => {
  const clerk = clerkBridge();
  render(<DeveloperLandingPage authConfig={clerkEnabled} clerk={clerk} />);

  const signUp = screen.getAllByRole("button", { name: /Create your account/u });
  expect(signUp).toHaveLength(2);
  fireEvent.click(signUp[1]);
  expect(clerk.openSignUp).toHaveBeenCalled();
});

test("explains a gateway with no sign-in configured instead of showing a dead button", () => {
  render(
    <DeveloperLandingPage
      authConfig={{ clerk: { enabled: false, publishableKey: null }, gatewayReachable: true }}
      clerk={null}
    />,
  );

  expect(screen.getAllByText(/Sign-in is not configured/u).length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: /Create your account/u })).not.toBeInTheDocument();
});

// The gateway answering with an error is not the gateway saying "no sign-in here". The two states
// get different copy, so an operator is not sent to set keys that are already bound.
test("blames the deployment, not the keys, when the gateway did not answer", () => {
  render(
    <DeveloperLandingPage
      authConfig={{ clerk: { enabled: false, publishableKey: null }, gatewayReachable: false }}
      clerk={null}
    />,
  );

  expect(screen.getAllByText(/gateway is not answering/u).length).toBeGreaterThan(0);
  expect(screen.queryByText(/Sign-in is not configured/u)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Create your account/u })).not.toBeInTheDocument();
});

test("links across to the other signed-out pages", () => {
  const { container } = render(<DeveloperLandingPage authConfig={clerkEnabled} clerk={clerkBridge()} />);

  expect(container.querySelector('a[href="#/"]')).not.toBeNull();
  expect(container.querySelector('a[href="#/early-access"]')).not.toBeNull();
  // It should not offer a link to the page you are already on.
  expect(container.querySelector('a[href="#/developers"]')).toBeNull();
});
