import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import type { AuthConfig, ClerkBridge } from "../types";
import { SignInNotice, signInAvailability } from "./signInNotice";

function clerkBridge(): ClerkBridge {
  return {
    loaded: true,
    signedIn: false,
    userLabel: null,
    getToken: vi.fn(async () => null),
    openSignIn: vi.fn(),
    openSignUp: vi.fn(),
    openUserProfile: vi.fn(),
    signOut: vi.fn(async () => {}),
  };
}

const clerkEnabled: AuthConfig = { clerk: { enabled: true, publishableKey: "pk_test_x" } };
const clerkDisabled: AuthConfig = { clerk: { enabled: false, publishableKey: null } };

test("treats an answer from the gateway and a failure to reach it as different states", () => {
  expect(signInAvailability(clerkEnabled, clerkBridge())).toBe("ready");
  expect(signInAvailability(clerkDisabled, null)).toBe("unconfigured");
  // The gateway never answered. Its Clerk keys may be perfectly configured.
  expect(signInAvailability({ ...clerkDisabled, gatewayReachable: false }, null)).toBe("unreachable");
  // A reachable gateway that cannot answer with keys is still "unconfigured", not "unreachable".
  expect(signInAvailability({ ...clerkDisabled, gatewayReachable: true }, null)).toBe("unconfigured");
});

test("says the gateway is not answering without pointing at the keys", () => {
  render(<SignInNotice availability="unreachable" />);

  expect(screen.getByText(/gateway is not answering/u)).toBeInTheDocument();
  expect(screen.queryByText(/Sign-in is not configured/u)).not.toBeInTheDocument();
  expect(screen.queryByText("CLERK_SECRET_KEY")).not.toBeInTheDocument();
});

test("points at the keys when the gateway answered that sign-in is off", () => {
  render(<SignInNotice availability="unconfigured" />);

  expect(screen.getByText(/Sign-in is not configured/u)).toBeInTheDocument();
  expect(screen.getByText("CLERK_PUBLISHABLE_KEY")).toBeInTheDocument();
  expect(screen.getByText("CLERK_SECRET_KEY")).toBeInTheDocument();
});

test("renders nothing when sign-in is ready", () => {
  const { container } = render(<SignInNotice availability="ready" />);

  expect(container.firstChild).toBeNull();
});
