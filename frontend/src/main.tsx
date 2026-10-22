import {
  ClerkProvider,
  useClerk,
  useSession,
  useUser,
} from "@clerk/react";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { registerServiceWorker } from "./pwa";
import type { AuthConfig, ClerkBridge } from "./types";
import "./styles.css";
// The console's half of the "intelligence design" system. Imported last so its palette and
// primitives win over the legacy sheet on equal specificity.
import "./intelligence.css";

/**
 * How long the console waits for the gateway's auth configuration before it gives up and says the
 * gateway is not answering. A gateway that never replies must not leave the front door spinning
 * forever.
 */
const AUTH_CONFIG_TIMEOUT_MS = 8_000;

/**
 * The configuration used when the gateway could not be asked at all.
 *
 * `gatewayReachable: false` is the whole point: the console did not receive a configuration, so
 * it must not claim that the gateway has no sign-in configured. The keys may be present and the
 * service behind them may simply be down.
 */
function unreachableAuthConfig(): AuthConfig {
  return {
    authProvider: "clerk",
    developmentTokens: { enabled: false },
    clerk: { enabled: false, publishableKey: null },
    gatewayReachable: false,
  };
}

async function loadAuthConfig(): Promise<AuthConfig> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_CONFIG_TIMEOUT_MS);
  try {
    const response = await fetch("/v1/auth/config", { signal: controller.signal });
    // A non-2xx answer is not a configuration. The gateway refused or failed to produce one, and
    // that is an availability problem, not a statement about Clerk.
    if (!response.ok) return unreachableAuthConfig();
    return { ...(await response.json() as AuthConfig), gatewayReachable: true };
  } catch {
    // Network failure or timeout: the gateway never answered.
    return unreachableAuthConfig();
  } finally {
    clearTimeout(timer);
  }
}

function ClerkConnectedApp({ authConfig }: { authConfig: AuthConfig }) {
  const clerk = useClerk();
  const { session, isLoaded: sessionLoaded } = useSession();
  const { user, isLoaded: userLoaded } = useUser();
  const bridge = useMemo<ClerkBridge>(() => ({
    loaded: sessionLoaded && userLoaded,
    signedIn: Boolean(session),
    userLabel:
      user?.primaryEmailAddress?.emailAddress
      ?? user?.fullName
      ?? user?.id
      ?? null,
    getToken: async () => session?.getToken() ?? null,
    openSignIn: () => clerk.openSignIn(),
    openSignUp: () => clerk.openSignUp(),
    openUserProfile: () => clerk.openUserProfile(),
    signOut: async () => {
      await clerk.signOut();
    },
  }), [clerk, session, sessionLoaded, user, userLoaded]);

  return <App authConfig={authConfig} clerk={bridge} />;
}

async function bootstrap() {
  const authConfig = await loadAuthConfig();
  const root = createRoot(document.getElementById("root")!);
  const app = authConfig.clerk?.enabled && authConfig.clerk.publishableKey ? (
    <ClerkProvider
      publishableKey={authConfig.clerk.publishableKey}
      afterSignOutUrl="/"
      appearance={{
        // The console's palette is two tone, and the account surfaces Clerk
        // renders are part of it: black ground, white ink, greys for the rest.
        variables: {
          colorPrimary: "#ffffff",
          colorPrimaryForeground: "#0a0a0b",
          colorForeground: "#f2f2f0",
          colorMutedForeground: "#9b9b9e",
          colorBackground: "#0e0f11",
          colorMuted: "#141518",
          colorInput: "#0a0a0b",
          colorInputForeground: "#f2f2f0",
          colorNeutral: "#f2f2f0",
          colorBorder: "#2a2a30",
          colorRing: "#ffffff",
          colorModalBackdrop: "#070708",
          borderRadius: "0.625rem",
        },
      }}
    >
      <ClerkConnectedApp authConfig={authConfig} />
    </ClerkProvider>
  ) : (
    <App authConfig={authConfig} />
  );

  root.render(<StrictMode>{app}</StrictMode>);
}

void bootstrap();
void registerServiceWorker();
