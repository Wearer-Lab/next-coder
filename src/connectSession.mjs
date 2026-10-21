// Console-first T3 pairing.
//
// Connecting the first environment used to start on the T3 host: run the wizard, copy a token, come
// back to the browser and paste it. That order is backwards — the person is already signed in to the
// console, and the console is the only place that knows which account the host should land in.
//
// A connect session inverts it. The console mints a short-lived, single-use enrollment code while
// the user is authenticated, hands them one command to run on the host, and then polls. The
// connector CLI redeems the code at `POST /v1/connectors/enroll`, which is deliberately *not* in the
// platform-user realm: the CLI has no Clerk session and the copyable one-liner never carries a
// platform token or local T3 credential.
//
// The code is the credential, so it follows the device claim-code rules exactly: hashed at rest,
// compared with timingSafeEqual, single use, and refused (not ignored) once expired.

// Minutes, not days. Unlike a device claim code — printed at manufacture and read weeks later — this
// one is read off the screen and pasted into a terminal in the same sitting.
export const CONNECT_SESSION_TTL_MS = 15 * 60 * 1000;

export const CONNECT_ACCESS_MODES = ["local", "tailscale", "online"];

// A session is terminal once it leaves `pending`/`redeeming`; the console stops polling there.
export const CONNECT_SESSION_STATUSES = ["pending", "redeeming", "completed", "failed", "expired"];

export function normalizeConnectAccessMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return CONNECT_ACCESS_MODES.includes(mode) ? mode : "local";
}

// The `--tunnel` flag setup:t3 understands is local/tailscale/lan/custom, which is not the same
// vocabulary as the console's access modes. Online endpoints are reached through a tunnel the user
// already owns, so the flag is left off rather than guessed at.
export function tunnelForAccessMode(mode) {
  if (mode === "tailscale") return "tailscale";
  if (mode === "local") return "local";
  return null;
}

/**
 * The single line the console asks the user to run on the T3 host. Built on the server so there is
 * exactly one implementation of it, and so the gateway URL comes from the gateway itself rather than
 * from whatever origin the browser happens to be on.
 */
export function buildConnectCommand({ gatewayUrl, code }) {
  return [
    "npx @next-coder/connector connect",
    "--server",
    shellQuote(String(gatewayUrl).replace(/\/+$/u, "")),
    "--code",
    shellQuote(code),
  ].join(" ");
}

export function buildConnectorRotateCommand({ gatewayUrl, code }) {
  return [
    "npx @next-coder/connector rotate",
    "--server",
    shellQuote(String(gatewayUrl).replace(/\/+$/u, "")),
    "--code",
    shellQuote(code),
    "--yes",
  ].join(" ");
}

/**
 * Repository-local migration path for the old direct T3 pairing flow. New console onboarding must
 * use buildConnectCommand; this is explicitly named so a caller cannot select direct mode by
 * accidentally forwarding the UI's accessMode field.
 */
export function buildLegacyDirectConnectCommand({ gatewayUrl, code, accessMode = "local" }) {
  const parts = [
    "npm run setup:t3 --",
    "--gateway-url",
    shellQuote(String(gatewayUrl).replace(/\/+$/u, "")),
    "--connect-code",
    shellQuote(code),
  ];
  const tunnel = tunnelForAccessMode(normalizeConnectAccessMode(accessMode));
  if (tunnel) parts.push("--tunnel", shellQuote(tunnel));
  return parts.join(" ");
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
