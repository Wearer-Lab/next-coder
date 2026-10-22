import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// jsdom replaces the global URL implementation, so resolve the path as a plain string
// rather than handing a jsdom URL object to node:url.
const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "sw.js"),
  "utf8",
);

type Route = "bypass" | "navigate" | "asset" | "passive";

interface ServiceWorkerInternals {
  routeFor: (request: { method: string; url: string; mode?: string }) => Route;
  isApiPath: (pathname: string) => boolean;
  isPublicStaticPath: (pathname: string) => boolean;
  PRECACHE_URLS: string[];
}

/**
 * Evaluates the shipped service worker against a stub global so the caching policy is
 * covered by the same file the browser installs, not a copy of it.
 */
function loadServiceWorker(): { internals: ServiceWorkerInternals; events: string[] } {
  const events: string[] = [];
  const scope = {
    location: new URL("https://console.example.test/"),
    addEventListener: (type: string) => {
      events.push(type);
    },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: async () => [],
      openWindow: async () => null,
    },
    __swInternals: undefined as ServiceWorkerInternals | undefined,
  };
  // eslint-disable-next-line no-new-func -- deliberate: run the real worker source in a sandbox.
  new Function("self", source)(scope);
  if (!scope.__swInternals) throw new Error("Service worker did not expose its internals.");
  return { internals: scope.__swInternals, events };
}

function get(url: string, init: { method?: string; mode?: string } = {}) {
  return { method: init.method ?? "GET", url, mode: init.mode ?? "cors" };
}

describe("service worker caching policy", () => {
  const { internals, events } = loadServiceWorker();

  test("never caches gateway API traffic", () => {
    expect(internals.routeFor(get("https://console.example.test/v1/commands"))).toBe("bypass");
    expect(internals.routeFor(get("https://console.example.test/v1"))).toBe("bypass");
    expect(internals.routeFor(get("https://console.example.test/v1/devices/abc/config"))).toBe("bypass");
    expect(internals.routeFor(get("https://console.example.test/health"))).toBe("bypass");
    expect(
      internals.routeFor(get("https://console.example.test/v1/events", { mode: "navigate" })),
    ).toBe("bypass");
    expect(internals.PRECACHE_URLS.some((url) => internals.isApiPath(url))).toBe(false);
  });

  test("leaves non-GET, cross-origin, and legacy requests to the network", () => {
    expect(internals.routeFor(get("https://console.example.test/", { method: "POST" }))).toBe("bypass");
    expect(internals.routeFor(get("https://clerk.example.test/v1/client"))).toBe("bypass");
    expect(internals.routeFor(get("https://console.example.test/legacy/"))).toBe("bypass");
    expect(internals.routeFor(get("https://console.example.test/legacy/app.js"))).toBe("bypass");
  });

  test("does not persist unknown same-origin reads that may become private routes", () => {
    expect(internals.routeFor(get("https://console.example.test/account/export"))).toBe("bypass");
    expect(internals.routeFor(get("https://console.example.test/downloads/private.txt"))).toBe("bypass");
    expect(internals.isPublicStaticPath("/manifest.webmanifest")).toBe(true);
    expect(internals.isPublicStaticPath("/icons/icon-192.png")).toBe(true);
    expect(internals.isPublicStaticPath("/account/export")).toBe(false);
  });

  test("serves the app shell and hashed assets from cache", () => {
    expect(
      internals.routeFor(get("https://console.example.test/", { mode: "navigate" })),
    ).toBe("navigate");
    expect(
      internals.routeFor(get("https://console.example.test/assets/index-abc123.js")),
    ).toBe("asset");
    expect(internals.routeFor(get("https://console.example.test/manifest.webmanifest"))).toBe("passive");
    expect(internals.routeFor(get("https://console.example.test/icons/icon-192.png"))).toBe("passive");
  });

  test("revalidates the public files that live in /assets/ but are not content-hashed", () => {
    // The brand mark is served from a stable URL, so a cache-first rule would keep serving the
    // previous file after a deploy.
    expect(internals.routeFor(get("https://console.example.test/assets/logo.webp"))).toBe("passive");
    // Everything else under /assets/ IS content-hashed, so it stays cache-first.
    expect(internals.routeFor(get("https://console.example.test/assets/index-abc123.js"))).toBe("asset");
  });

  test("registers the lifecycle and notification handlers the console relies on", () => {
    expect(events).toEqual(
      expect.arrayContaining(["install", "activate", "fetch", "push", "notificationclick"]),
    );
  });
});
