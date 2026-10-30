// A short-lived, scoped read cache with single-flight, for reads that cross the connector to T3.
//
// WHY. A controller's reads are independent HTTP requests, but several of them need the same
// upstream fact: `threads`, `projects`, `config/thread` and `config/project` all need the
// environment's orchestration snapshot, and `approvals` asks for the same unwindowed thread detail
// twice (provider approvals and agent questions) in parallel. Each of those was its own round trip
// through the Durable Object to the user's laptop. Concurrent callers now share one flight, and a
// tap-sized burst can share one result.
//
// WHAT IT IS NOT. It never holds an authentication or authorisation decision and never holds
// anything derived from a device's binding. The caller keys by user and environment, authenticates
// before it gets here, and projects the shared value through the CURRENT device record afterwards.
// The value cached is what T3 said, nothing the gateway decided.
//
// FRESHNESS IS THE READER'S CHOICE, not the entry's. `maxAgeMs: 0` means "never serve stored data;
// only join a flight that is already in the air" — the discipline for the reply path. A positive
// bound accepts an entry up to that old. `fresh: true` accepts neither a stored entry nor someone
// else's flight, which is how a validation retries after a miss.
//
// INVALIDATION IS A GENERATION, NOT A DELETE. `invalidate(scope)` bumps the scope's generation and
// drops its entries. A flight launched under an older generation is neither joinable afterwards nor
// allowed to store its result, so a dispatch that completes while a read is in the air can never
// have that read's pre-dispatch answer served to anyone who started after the dispatch.
//
// VALUES ARE COPIED on the way out. A snapshot is large and handlers project it freely; handing
// every caller the same object would make one caller's mutation another's data.

const DEFAULT_MAX_SCOPES = 256;
// An entry nobody asked for within this long is dropped on the next insert. It bounds memory for
// environments that stop being polled; it is not a freshness bound (readers pass their own).
const RETAIN_MS = 60_000;

export function createReadCoalescer({
  now = Date.now,
  maxScopes = DEFAULT_MAX_SCOPES,
  copy = structuredClone,
} = {}) {
  /** scope -> { generation, entries: Map<key, {value, at}>, flights: Map<key, {promise, generation}> } */
  const scopes = new Map();

  function scopeState(scope) {
    let state = scopes.get(scope);
    if (!state) {
      state = { generation: 0, entries: new Map(), flights: new Map() };
      scopes.set(scope, state);
      prune();
    }
    return state;
  }

  function prune() {
    if (scopes.size <= maxScopes) return;
    const cutoff = now() - RETAIN_MS;
    for (const [scope, state] of scopes) {
      for (const [key, entry] of state.entries) if (entry.at < cutoff) state.entries.delete(key);
      if (state.entries.size === 0 && state.flights.size === 0) scopes.delete(scope);
    }
    // Still over: drop the oldest idle scopes. Insertion order is age order.
    for (const [scope, state] of scopes) {
      if (scopes.size <= maxScopes) break;
      if (state.flights.size === 0) scopes.delete(scope);
    }
  }

  /**
   * @returns {Promise<{value: *, source: "hit"|"join"|"miss"}>}
   */
  async function read({ scope, key, maxAgeMs = 0, fresh = false, retain = true, load }) {
    const state = scopeState(scope);
    if (!fresh && maxAgeMs > 0) {
      const entry = state.entries.get(key);
      if (entry && now() - entry.at <= maxAgeMs) return { value: copy(entry.value), source: "hit" };
    }
    if (!fresh) {
      const flight = state.flights.get(key);
      if (flight && flight.generation === state.generation) {
        return { value: copy(await flight.promise), source: "join" };
      }
    }
    const generation = state.generation;
    const startedAt = now();
    const flight = { generation, promise: Promise.resolve().then(load) };
    state.flights.set(key, flight);
    try {
      const value = await flight.promise;
      // Recorded at the moment the read STARTED: the value describes T3 no later than that.
      if (retain && state.generation === generation) state.entries.set(key, { value, at: startedAt });
      return { value: copy(value), source: "miss" };
    } finally {
      if (state.flights.get(key) === flight) state.flights.delete(key);
    }
  }

  function invalidate(scope) {
    const state = scopes.get(scope);
    if (!state) return;
    state.generation += 1;
    state.entries.clear();
  }

  /** Every scope whose key starts with `prefix` — used to drop everything a user owns. */
  function invalidatePrefix(prefix) {
    for (const scope of [...scopes.keys()]) if (scope.startsWith(prefix)) invalidate(scope);
  }

  return { read, invalidate, invalidatePrefix, size: () => scopes.size };
}
