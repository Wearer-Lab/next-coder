import "@testing-library/jest-dom/vitest";

// Node 22+ exposes an experimental `globalThis.localStorage` that resolves to undefined
// unless the runtime was started with --localstorage-file, and it shadows the jsdom one.
// The console only ever uses storage for preferences, so an in-memory shim is enough.
if (typeof globalThis.localStorage === "undefined") {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(String(key)) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(String(key));
    },
    setItem: (key: string, value: string) => {
      entries.set(String(key), String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
}

// The console's motion primitives draw on a canvas and watch element geometry. jsdom implements
// neither, so without these stubs every page that renders an orb or a live frame throws on mount
// and the test failure describes a missing browser API rather than the component under test.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: number[] = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

// A 2d context that accepts every call and measures nothing. The orb only ever paints — no test
// reads a pixel back — so recording the calls would be state nobody asserts on.
if (typeof HTMLCanvasElement !== "undefined") {
  const noop = () => {};
  HTMLCanvasElement.prototype.getContext = ((kind: string) => kind === "2d"
    ? new Proxy({}, {
      get(_target, property) {
        if (property === "canvas") return undefined;
        if (property === "measureText") return () => ({ width: 0 });
        if (property === "createLinearGradient" || property === "createRadialGradient") {
          return () => ({ addColorStop: noop });
        }
        if (property === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
        return noop;
      },
      set() {
        return true;
      },
    })
    : null) as HTMLCanvasElement["getContext"];
}

// The marketing backdrop is a looping <video>. jsdom implements the media element but not the
// decoding behind it, so every play() logs "Not implemented" and every pause() throws. The
// component only asks the browser to start and stop the loop, so a no-op pair is the whole
// surface the tests need.
if (typeof HTMLMediaElement !== "undefined") {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
}

// Several of the motion primitives ask the browser about `prefers-reduced-motion` before they
// animate anything. jsdom ships no `matchMedia`, and the app's own callers all guard with `?.`,
// so nothing needed one until now.
// Installed on globalThis rather than behind a `typeof window` guard: under CPU contention some
// vitest worker init orders evaluate a dependency's module body before `window` is assigned, and
// border-beam throws out of module scope where no test can catch it. Assigning unconditionally
// costs nothing and removes the race.
if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof globalThis.matchMedia;
}
