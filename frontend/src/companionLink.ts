const STORAGE_KEY = "next-coder:companion-handoff";

/**
 * Reads a one-shot companion bearer from the hash, removes it from the visible URL, and keeps it
 * only in session storage while sign-in completes. Fragments never reach HTTP logs or referrers.
 */
export function readCompanionCode(): string | null {
  const hash = window.location.hash.replace(/^#\/?/u, "");
  const [route, query = ""] = hash.split("?", 2);
  const code = route === "media" ? new URLSearchParams(query).get("handoff") : null;
  if (code && /^[A-Za-z0-9_-]{24,128}$/u.test(code)) {
    try {
      sessionStorage.setItem(STORAGE_KEY, code);
    } catch {
      // The in-memory return still lets a signed-in private-browsing tab claim immediately.
    }
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/media`);
    return code;
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearCompanionCode(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Already inaccessible.
  }
}
