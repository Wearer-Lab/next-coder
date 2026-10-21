import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { AuthConfig, ClerkBridge } from "../types";
import { LandingPage } from "./LandingPage";

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

test("offers sign-up and sign-in as separate doors", () => {
  const clerk = clerkBridge();
  render(<LandingPage authConfig={clerkEnabled} clerk={clerk} />);

  // The page repeats the account CTA (header, hero, and the Hosted pricing tier), so this asserts
  // the invariant rather than a single button: every create-account affordance opens sign-up, and
  // none of them silently falls through to sign-in.
  const signUpButtons = screen.getAllByRole("button", { name: /Create (your )?account/u });
  expect(signUpButtons.length).toBeGreaterThan(1);
  for (const button of signUpButtons) {
    (clerk.openSignUp as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(button);
    expect(clerk.openSignUp).toHaveBeenCalledTimes(1);
  }
  expect(clerk.openSignIn).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /I already have one/u }));
  expect(clerk.openSignIn).toHaveBeenCalled();
});

test("says what the product does before asking for an account", () => {
  render(<LandingPage authConfig={clerkEnabled} clerk={clerkBridge()} />);

  expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  expect(screen.getByText(/never runs the agent itself/u)).toBeInTheDocument();
  expect(screen.getByText(/Pair your T3 Code host/u)).toBeInTheDocument();
  expect(screen.getByText(/Add a controller, or don't/u)).toBeInTheDocument();
});

// A self-hoster who has not finished wiring Clerk needs the reason. A sign-up button that
// silently does nothing is the worst version of this screen.
test("explains a gateway with no sign-in configured instead of showing a dead button", () => {
  render(<LandingPage authConfig={{ clerk: { enabled: false, publishableKey: null } }} clerk={null} />);

  expect(screen.getByText(/Sign-in is not configured/u)).toBeInTheDocument();
  expect(screen.getByText("CLERK_SECRET_KEY")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Create your account/u })).not.toBeInTheDocument();
});

test("covers hardware, capabilities, pricing and FAQ below the hero", () => {
  render(<LandingPage authConfig={clerkEnabled} clerk={clerkBridge()} />);

  expect(screen.getByRole("heading", { name: /One knob, one e-ink face/u })).toBeInTheDocument();
  expect(screen.getByText("EC11 rotary encoder + press")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Policy gate with real approvals/u })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Self-hosted" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Hosted" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Team" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Does Next Coder run the model\?/u })).toBeInTheDocument();
});

// Every in-page link has to resolve to something that exists. A marketing header whose nav
// scrolls nowhere is worse than a header with no nav at all. `#/…` hrefs are routes to the other
// signed-out pages, not anchors, so they are checked against the router instead.
test("only links to sections that are actually rendered", () => {
  const { container } = render(<LandingPage authConfig={clerkEnabled} clerk={clerkBridge()} />);

  const hrefs = Array.from(container.querySelectorAll("a[href^='#']")).map(
    (anchor) => anchor.getAttribute("href") ?? "",
  );
  const anchors = hrefs.filter((href) => !href.startsWith("#/"));
  const routes = hrefs.filter((href) => href.startsWith("#/"));

  expect(anchors.length).toBeGreaterThan(0);
  for (const href of anchors) {
    expect(container.querySelector(href), `${href} has no target on the page`).not.toBeNull();
  }

  expect(routes.length).toBeGreaterThan(0);
  for (const href of routes) {
    expect(["#/", "#/developers", "#/early-access"], `${href} is not a route`).toContain(href);
  }
});

// The team waitlist has no signup path behind it yet, so its CTA must not imply one.
test("does not present the team waitlist as something you can join today", () => {
  render(<LandingPage authConfig={clerkEnabled} clerk={clerkBridge()} />);

  expect(screen.getByRole("button", { name: /Join the waitlist/u })).toBeDisabled();
});

test("holds the CTAs disabled while Clerk is still resolving the session", () => {
  render(<LandingPage authConfig={clerkEnabled} clerk={clerkBridge({ loaded: false })} />);

  expect(screen.getByRole("button", { name: /Checking session/u })).toBeDisabled();
  expect(screen.getByRole("button", { name: /I already have one/u })).toBeDisabled();
});
