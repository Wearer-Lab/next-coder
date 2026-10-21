// A controller polls GET /v1/device/display every five seconds, and under the Convex store that
// summary is a round trip out to the deployment. Measured against a live device the query
// intermittently exceeded the firmware's request timeout, which the device reports as
// HTTPClient error(-11) and which costs it a dropped frame budget on every occurrence.
//
// The summary is derived state — counts and the two newest rows — so it can be served from the
// last computed value for a short window. The window is deliberately shorter than the poll
// interval, and any store write for that user drops the entry outright (see invalidateDisplayCache,
// wired to store.subscribe in createApp), so a cached read can only ever repeat a value that was
// correct and that nothing has changed since.
const DISPLAY_CACHE_TTL_MS = 2000;
const displayCache = new Map();

export function invalidateDisplayCache(userId) {
  if (userId) displayCache.delete(userId);
  else displayCache.clear();
}

// Caching is opt-in, and only the HTTP routes opt in. This function is otherwise pure, and a
// caller that has just written to the store and reads back a value it did not invalidate would get
// the previous one — which is exactly what happened when the cache was unconditional and a test
// mutated the store directly. Freshness is the default; the routes are the only callers wired to
// invalidateDisplayCache, so they are the only ones entitled to a cached read.
export async function buildUserDisplayState(store, userId, { cache = false, now = Date.now } = {}) {
  if (!cache) return computeUserDisplayState(store, userId);
  const cached = displayCache.get(userId);
  if (cached && now() - cached.at < DISPLAY_CACHE_TTL_MS) return cached.value;
  const value = await computeUserDisplayState(store, userId);
  displayCache.set(userId, { at: now(), value });
  return value;
}

async function computeUserDisplayState(store, userId) {
  // One bounded store call, not six unbounded ones.
  //
  // This used to fetch every environment, device, media upload, macro, command and audit entry the
  // account had ever produced, and then read `.length` and `.at(-1)` off them. Batching the six
  // with Promise.all fixed the round-trip count but not the payload: the audit log grows on every
  // write, so a device polling this route every five seconds was dragging a monotonically larger
  // history across the wire forever, and the firmware logged `HTTPClient error(-11): read Timeout`
  // on roughly every poll. `getDisplaySummary()` answers with counts and two small projections, so
  // the work and the response are the same size on an account's first day and its thousandth.
  const { counts, latestCommand, latestAudit } = await store.getDisplaySummary(userId);

  // `counts` is passed through verbatim and its keys are fixed by the store, because firmware
  // parses these field names (applyDisplayJson in GatewayOperate.cpp) and a renamed or reordered
  // key is a silent regression on hardware nothing here can test.
  return {
    title: "Next Coder",
    state: counts.environments > 0 ? "ready" : "setup",
    line1: `${counts.environments} env / ${counts.devices} devices`,
    line2: latestCommand ? `${latestCommand.status}: ${latestCommand.intentType}` : "No commands yet",
    counts,
    latestAction: latestAudit?.action ?? null,
    menu: ["status", "prompt", "shell", "macro", "media", "stop"],
  };
}

export async function buildDeviceDisplayState(store, device, options = {}) {
  const base = await buildUserDisplayState(store, device.userId, { cache: options.cache === true });
  const configuredMenu = Array.isArray(device.config?.menu) && device.config.menu.length > 0
    ? device.config.menu
    : base.menu;
  return {
    ...base,
    // Firmware applies the display menu every poll and the config menu far less often,
    // so a generic menu here silently overwrites whatever the owner configured.
    menu: configuredMenu,
    title: device.label || "Controller",
    device: {
      id: device.id,
      profile: device.profile,
      lastSeenAt: device.lastSeenAt,
      status: device.status ?? null,
      presence: device.presence ?? null,
    },
    selectedEnvironmentId: options.environmentId ?? null,
  };
}
