/* Next Coder service worker.
 *
 * Caching rules, in priority order:
 *   1. Anything that is not a same-origin GET is bypassed entirely.
 *   2. `/v1/*` and `/health` are NEVER cached and never served from cache. They are
 *      session-authenticated and describe live device/command state — a stale answer
 *      here would show an operator the wrong state of real hardware.
 *   3. `/legacy/*` is left to the network so the pre-React dashboard is never shadowed.
 *   4. Navigations are network-first with the cached app shell as the offline fallback.
 *   5. Build assets under `/assets/` are content-hashed, so cache-first is safe — EXCEPT the
 *      hand-authored public files that live in the same directory (`/assets/logo.webp`), whose
 *      URL never changes. Those are stale-while-revalidate, or a redeployed logo would be masked
 *      by the cache until the cache name changed.
 *   6. Only the explicit public-static allowlist (manifest and icons) is
 *      stale-while-revalidate. Unknown same-origin GETs stay on the network so a future
 *      authenticated route cannot silently become persistent browser-cache content.
 *
 * Registered only from production builds — see frontend/src/pwa.ts.
 */

const VERSION = "v1";
const SHELL_CACHE = `next-coder-shell-${VERSION}`;
const ASSET_CACHE = `next-coder-assets-${VERSION}`;
const SHELL_URL = "/";
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

function isApiPath(pathname) {
  return pathname === "/health" || pathname === "/v1" || pathname.startsWith("/v1/");
}

function isLegacyPath(pathname) {
  return pathname === "/legacy" || pathname.startsWith("/legacy/");
}

function isPublicStaticPath(pathname) {
  return pathname === "/manifest.webmanifest" || pathname.startsWith("/icons/");
}

/**
 * Public files that are served from `/assets/` but are NOT content-hashed: their URL is stable, so
 * a cache-first rule would keep serving the previous file after a deploy. They are revalidated
 * instead.
 */
const UNVERSIONED_ASSET_PATHS = new Set(["/assets/logo.webp"]);

function isUnversionedAssetPath(pathname) {
  return UNVERSIONED_ASSET_PATHS.has(pathname);
}

/** Returns the caching strategy for a request: bypass | navigate | asset | passive. */
function routeFor(request) {
  if (request.method !== "GET") return "bypass";
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return "bypass";
  }
  if (url.origin !== self.location.origin) return "bypass";
  if (isApiPath(url.pathname)) return "bypass";
  if (isLegacyPath(url.pathname)) return "bypass";
  if (request.mode === "navigate") return "navigate";
  if (isUnversionedAssetPath(url.pathname)) return "passive";
  if (url.pathname.startsWith("/assets/")) return "asset";
  if (isPublicStaticPath(url.pathname)) return "passive";
  return "bypass";
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(SHELL_URL, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ?? network;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("next-coder-") && key !== SHELL_CACHE && key !== ASSET_CACHE)
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const route = routeFor(event.request);
  if (route === "bypass") return;
  if (route === "navigate") {
    event.respondWith(networkFirstShell(event.request));
    return;
  }
  if (route === "asset") {
    event.respondWith(cacheFirstAsset(event.request));
    return;
  }
  event.respondWith(staleWhileRevalidate(event.request));
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") void self.skipWaiting();
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { payload = {}; }
  const title = typeof payload.title === "string" && payload.title.length <= 80
    ? payload.title
    : "Next Coder update";
  const body = typeof payload.body === "string" && payload.body.length <= 160
    ? payload.body
    : "Open Next Coder to review this update.";
  const candidateUrl = typeof payload.url === "string" ? payload.url : "/#activity?view=notifications";
  const url = candidateUrl.startsWith("/#activity?") ? candidateUrl : "/#activity?view=notifications";
  const tag = typeof payload.tag === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(payload.tag)
    ? payload.tag
    : "next-coder-attention";
  event.waitUntil(self.registration.showNotification(title, { body, tag, data: { url } }));
});

// Local and Web Push notifications share one same-origin click path. Never navigate to a URL from
// a push payload unless it matches the notification-center route above.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/#activity";
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clientList) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ("navigate" in client) await client.navigate(target).catch(() => undefined);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

self.__swInternals = {
  routeFor,
  isApiPath,
  isLegacyPath,
  isPublicStaticPath,
  SHELL_CACHE,
  ASSET_CACHE,
  PRECACHE_URLS,
};
