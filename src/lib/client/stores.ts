// Tiny external stores read with useSyncExternalStore. A ticking clock for elapsed counters and
// memory timers (so render never calls Date.now), and media queries for the phone layout.

type Listener = () => void;

/** A clock that ticks only while someone listens. Snapshot is epoch ms, 0 on the server. */
export function createClock(intervalMs: number) {
  let now = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<Listener>();
  const tick = () => {
    now = Date.now();
    for (const l of [...listeners]) l();
  };
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      if (!timer) {
        now = Date.now();
        timer = setInterval(tick, intervalMs);
        queueMicrotask(() => listener());
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    getSnapshot: () => now,
    getServerSnapshot: () => 0,
  };
}

/** A media query as a store. False on the server. */
export function createMediaQueryStore(query: string) {
  let mql: MediaQueryList | null = null;
  const get = (): MediaQueryList | null => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    if (!mql) mql = window.matchMedia(query);
    return mql;
  };
  return {
    subscribe(listener: Listener) {
      const list = get();
      if (!list) return () => undefined;
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    getSnapshot: () => get()?.matches ?? false,
    getServerSnapshot: () => false,
  };
}

export const clock250 = createClock(250);
export const clock1000 = createClock(1_000);
export const phoneQuery = createMediaQueryStore("(max-width: 480px)");
export const wideQuery = createMediaQueryStore("(min-width: 1024px)");
export const reducedMotionQuery = createMediaQueryStore("(prefers-reduced-motion: reduce)");
