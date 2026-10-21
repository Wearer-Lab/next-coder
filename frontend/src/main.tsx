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

async function loadAuthConfig(): Promise<AuthConfig> {
  try {
    const response = await fetch("/v1/auth/config");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as AuthConfig;
  } catch {
    return {
      authProvider: "clerk",
      developmentTokens: { enabled: false },
      clerk: { enabled: false, publishableKey: null },
    };
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
        variables: {
          colorPrimary: "#4f8f80",
          colorPrimaryForeground: "#f7fbf9",
          colorForeground: "#f2f5f4",
          colorMutedForeground: "#98a29f",
          colorBackground: "#171a19",
          colorMuted: "#202523",
          colorInput: "#111412",
          colorInputForeground: "#f2f5f4",
          colorNeutral: "#f2f5f4",
          colorBorder: "#343a38",
          colorRing: "#77a99c",
          colorModalBackdrop: "#080a09",
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
