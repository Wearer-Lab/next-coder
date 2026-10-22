import { CircleAlert } from "lucide-react";
import type { CSSProperties } from "react";

import type { AuthConfig, ClerkBridge } from "../types";

/**
 * What the signed-out pages are allowed to say about sign-in.
 *
 * - `ready`: Clerk is configured and the bridge is live. The pages show their account CTAs.
 * - `unconfigured`: the gateway answered and reported that Clerk is switched off.
 * - `unreachable`: the gateway could not answer — a 5xx, a network failure, or a timeout.
 *
 * The third state exists because "we could not ask" is not "the answer is no". A gateway whose
 * control plane is down still has its Clerk keys, and telling the operator to set environment
 * variables that are already set sends them to fix the wrong thing.
 */
export type SignInAvailability = "ready" | "unconfigured" | "unreachable";

/**
 * The one place that decides which of the three states the console is in.
 *
 * `gatewayReachable === false` wins over everything: the gateway never gave the console a
 * configuration, so nothing about its Clerk setup can be claimed.
 */
export function signInAvailability(
  authConfig: AuthConfig,
  clerk: ClerkBridge | null,
): SignInAvailability {
  if (authConfig.gatewayReachable === false) return "unreachable";
  if (authConfig.clerk?.enabled && clerk) return "ready";
  return "unconfigured";
}

/**
 * The signed-out pages' explanation of why there is no sign-in button.
 *
 * The two states get different copy on purpose. `unconfigured` points at the keys; `unreachable`
 * points at the deployment, because the keys may well be there and the service behind the
 * gateway is what failed to answer.
 */
export function SignInNotice({
  availability,
  className,
  style,
}: {
  availability: SignInAvailability;
  className?: string;
  style?: CSSProperties;
}) {
  if (availability === "ready") return null;

  if (availability === "unreachable") {
    return (
      <div
        className={["landing__notice", className].filter(Boolean).join(" ")}
        style={style}
        role="status"
      >
        <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">This gateway is not answering.</p>
          <p className="mt-1 text-xs leading-relaxed">
            The console could not load the sign-in configuration, so the gateway or the service
            behind it is unavailable for this deployment. Sign-in may still be configured — check
            the gateway's health, then reload this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={["landing__notice", className].filter(Boolean).join(" ")}
      style={style}
      role="status"
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-semibold">Sign-in is not configured on this gateway.</p>
        <p className="mt-1 text-xs leading-relaxed">
          Set <code>CLERK_PUBLISHABLE_KEY</code> and <code>CLERK_SECRET_KEY</code> in the gateway
          environment, then restart the service.
        </p>
      </div>
    </div>
  );
}
