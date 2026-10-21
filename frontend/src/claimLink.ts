// A scanned device QR lands on `/claim?device=…&code=…`. The gateway serves index.html for that
// path, but the app routes on `location.hash`, so without this module the parameters are read by
// nobody and the owner is dropped on Operate with no idea why.
//
// The parameters also have to survive a Clerk round trip: an unauthenticated scan has to sign in
// first, and a redirect-based flow replaces the URL. They are mirrored into sessionStorage — per
// tab, cleared on close — and consumed exactly once.

const STORAGE_KEY = "nextCoderClaimLink";

export interface ClaimLink {
  deviceId: string;
  code: string;
}

/** Claim codes are `ABCDE-12345`; entry is case- and separator-insensitive everywhere else. */
export function normalizeClaimCode(value: string): string {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/gu, "").slice(0, 10);
  return compact.length > 5 ? `${compact.slice(0, 5)}-${compact.slice(5)}` : compact;
}

function parse(search: string): ClaimLink | null {
  const params = new URLSearchParams(search);
  const deviceId = params.get("device")?.trim() ?? "";
  const code = normalizeClaimCode(params.get("code") ?? "");
  if (!deviceId || !code) return null;
  return { deviceId, code };
}

/**
 * Reads the claim link for this page load, preferring the URL and falling back to a link stashed
 * before an auth redirect. Reading also persists it, so the caller can safely tidy the URL.
 */
export function readClaimLink(location: Location = window.location): ClaimLink | null {
  const fromUrl = location.pathname.replace(/\/+$/u, "") === "/claim"
    ? parse(location.search)
    : null;
  if (fromUrl) {
    stashClaimLink(fromUrl);
    return fromUrl;
  }
  return peekStashedClaimLink();
}

export function stashClaimLink(link: ClaimLink): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(link));
  } catch {
    // Private-mode storage failures only cost the user a re-scan after signing in.
  }
}

export function peekStashedClaimLink(): ClaimLink | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClaimLink>;
    if (typeof parsed?.deviceId !== "string" || typeof parsed?.code !== "string") return null;
    if (!parsed.deviceId || !parsed.code) return null;
    return { deviceId: parsed.deviceId, code: parsed.code };
  } catch {
    return null;
  }
}

/** Called once the claim has been resolved — successfully or not — so a reload starts clean. */
export function clearClaimLink(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to recover from; the link is single-use either way.
  }
}

/**
 * Replaces `/claim?device=…&code=…` with the given hash route without a navigation, so the code
 * stops sitting in the address bar (and out of any screenshot or shared URL) once it is in hand.
 */
export function consumeClaimUrl(hashRoute = "#/devices"): void {
  clearClaimLink();
  try {
    window.history.replaceState(null, "", `/${hashRoute}`);
  } catch {
    // A replaceState failure is cosmetic.
  }
}
