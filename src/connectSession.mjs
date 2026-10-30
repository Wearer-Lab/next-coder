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
 * Shells the copyable command has to survive.
 *
 * `cmd` is the one that used to break. Command Prompt does not treat `'` as a quote character at
 * all, so `--server 'https://host'` arrived as the literal nine-plus characters including both
 * apostrophes and the enrollment failed on a malformed URL. PowerShell and POSIX shells both
 * accept single quotes, which is why this went unnoticed on macOS and in PowerShell.
 */
export const COMMAND_SHELLS = ["posix", "powershell", "cmd"];

/**
 * Characters that mean the same thing bare in every shell in COMMAND_SHELLS.
 *
 * Deliberately narrower than "what a URL may contain": `%` would be expanded by cmd.exe
 * (`%PATH%`), `!` by its delayed expansion, `$` and backticks by POSIX shells and PowerShell, and
 * `&`, `^`, `|`, `<`, `>`, `(`, `)` are separators or escapes somewhere. An argument built only
 * from this set needs no quoting anywhere, which is the only form that is correct in all three
 * without the console having to know which shell the user is in.
 */
const UNIVERSALLY_BARE = /^[A-Za-z0-9._:/@+=~-]+$/u;

/**
 * Quote one argument for one shell, preferring the bare form.
 *
 * The bare branch is not an optimisation — it is the whole point. A gateway origin and an
 * enrollment code (`[A-Z2-9]{5}-[A-Z2-9]{5}`, see createHumanCode) are always bare-safe, so the
 * command the console shows is byte-identical across the three shells and one copyable line
 * remains correct for every operating system. The quoting branches exist for a self-hosted gateway
 * URL carrying something unusual, where one line genuinely cannot serve all three.
 */
export function shellArgument(value, shell = "posix") {
  const text = String(value);
  if (UNIVERSALLY_BARE.test(text)) return text;
  // cmd.exe has no escape inside double quotes; a literal quote is doubled.
  if (shell === "cmd") return `"${text.replaceAll('"', '""')}"`;
  // PowerShell single-quoted strings suppress every expansion; a literal quote is doubled.
  if (shell === "powershell") return `'${text.replaceAll("'", "''")}'`;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Kept as the POSIX-only spelling the previous revision exported. New callers take
 * shellArgument(), which is shell-aware; this remains so an external caller that imported it does
 * not silently change behaviour.
 *
 * @deprecated Use shellArgument().
 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function normalizeGatewayUrl(gatewayUrl) {
  return String(gatewayUrl).replace(/\/+$/u, "");
}

/**
 * Render one command for each shell, plus the single `command` the console shows by default.
 *
 * `universal` says whether that default is correct everywhere. When every argument was bare-safe
 * the three renderings are identical and one line is enough; when they are not, the console has to
 * offer the per-shell variants rather than hand a Windows user a POSIX string and hope.
 */
function renderCommand(parts) {
  const commands = {};
  for (const shell of COMMAND_SHELLS) {
    commands[shell] = parts.map((part) => (part.literal ?? shellArgument(part.value, shell))).join(" ");
  }
  const universal = COMMAND_SHELLS.every((shell) => commands[shell] === commands.posix);
  return { command: commands.posix, commands, universal };
}

function literal(value) { return { literal: value }; }
function argument(value) { return { value }; }

/**
 * The single line the console asks the user to run on the T3 host. Built on the server so there is
 * exactly one implementation of it, and so the gateway URL comes from the gateway itself rather than
 * from whatever origin the browser happens to be on.
 *
 * Returns the string for backward compatibility with callers that only ever rendered one shell;
 * `connectCommandVariants()` exposes the per-shell set the console needs.
 */
export function buildConnectCommand({ gatewayUrl, code }) {
  return connectCommandVariants({ gatewayUrl, code }).command;
}

export function connectCommandVariants({ gatewayUrl, code }) {
  return renderCommand([
    literal("npx @wearer-haitch/connector connect"),
    literal("--server"),
    argument(normalizeGatewayUrl(gatewayUrl)),
    literal("--code"),
    argument(code),
  ]);
}

export function buildConnectorRotateCommand({ gatewayUrl, code }) {
  return connectorRotateCommandVariants({ gatewayUrl, code }).command;
}

export function connectorRotateCommandVariants({ gatewayUrl, code }) {
  return renderCommand([
    literal("npx @wearer-haitch/connector rotate"),
    literal("--server"),
    argument(normalizeGatewayUrl(gatewayUrl)),
    literal("--code"),
    argument(code),
    literal("--yes"),
  ]);
}

/**
 * Repository-local migration path for the old direct T3 pairing flow. New console onboarding must
 * use buildConnectCommand; this is explicitly named so a caller cannot select direct mode by
 * accidentally forwarding the UI's accessMode field.
 */
export function buildLegacyDirectConnectCommand({ gatewayUrl, code, accessMode = "local" }) {
  const parts = [
    literal("npm run setup:t3 --"),
    literal("--gateway-url"),
    argument(normalizeGatewayUrl(gatewayUrl)),
    literal("--connect-code"),
    argument(code),
  ];
  const tunnel = tunnelForAccessMode(normalizeConnectAccessMode(accessMode));
  if (tunnel) parts.push(literal("--tunnel"), argument(tunnel));
  return renderCommand(parts).command;
}
