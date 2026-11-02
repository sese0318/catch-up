// Screen Wake Lock for phones while listening (ux-spec 4 Phone, browser-audio.md 5.2). The lock
// drops whenever the page is hidden, so it is requested again on visibilitychange.

export interface WakeLockHandle {
  set(wanted: boolean): void;
  dispose(): void;
}

type Sentinel = { released: boolean; release(): Promise<void>; addEventListener(type: "release", cb: () => void): void };
type WakeLockApi = { request(type: "screen"): Promise<Sentinel> };

export function createWakeLock(doc: Document = document, nav: Navigator = navigator): WakeLockHandle {
  const api = (nav as unknown as { wakeLock?: WakeLockApi }).wakeLock;
  let wanted = false;
  let sentinel: Sentinel | null = null;
  let pending = false;

  const acquire = async () => {
    if (!api || !wanted || sentinel || pending || doc.visibilityState !== "visible") return;
    pending = true;
    try {
      const lock = await api.request("screen");
      if (!wanted) {
        await lock.release().catch(() => undefined);
        return;
      }
      sentinel = lock;
      lock.addEventListener("release", () => {
        if (sentinel === lock) sentinel = null;
      });
    } catch {
      // Low battery, policy or a hidden page. Catch Up keeps working without it.
    } finally {
      pending = false;
    }
  };

  const onVisibility = () => {
    if (doc.visibilityState === "visible") void acquire();
  };
  doc.addEventListener("visibilitychange", onVisibility);

  return {
    set(next) {
      wanted = next;
      if (next) void acquire();
      else if (sentinel) {
        const lock = sentinel;
        sentinel = null;
        void lock.release().catch(() => undefined);
      }
    },
    dispose() {
      this.set(false);
      doc.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
