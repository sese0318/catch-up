// Press guards (ux-spec 9 item 3), the demo guard next to the LIVE_ENABLED kill switch. Server only.
// Best effort and in memory. Each server instance keeps its own counts and a cold start resets them,
// so this caps spend on a demo, it is not a global quota. Live presses only, mock never counts.
// Client keys are kept as salted hashes for at most an hour and are never logged.
import { createHash, randomBytes } from "node:crypto";

const HOUR_MS = 3_600_000;
const MAX_TRACKED_KEYS = 10_000;

/** Live presses one client may have in flight at once, from the body upload to the end of the stream. */
export const MAX_IN_FLIGHT = 2;

export type HourlyCheck = { ok: true } | { ok: false; retryAfterSec: number };

export type Admission =
  | { ok: true }
  | { ok: false; code: "rate_limited"; retryAfterSec: number }
  | { ok: false; code: "daily_cap" };

export interface PressGuards {
  /** perHour 0 turns the per-client limit off. */
  checkHourly(clientKey: string, nowMs: number, perHour: number): HourlyCheck;
  /** True when this instance already ran cap live presses in the current UTC day. */
  dailyCapReached(nowMs: number, cap: number): boolean;
  /** Counts one live press toward both guards, once its body passed and a provider is about to run. */
  count(clientKey: string, nowMs: number, perHour: number): void;
  /**
   * Checks both guards again and counts the press in the same synchronous step, so presses that
   * passed the early checks together during their uploads can never overshoot either limit.
   */
  admit(clientKey: string, nowMs: number, perHour: number, cap: number): Admission;
  /**
   * Takes one of the client's in-flight slots. Returns the release function (safe to call twice),
   * or null when the client already has max presses in flight.
   */
  enter(clientKey: string, max?: number): (() => void) | null;
  reset(): void;
}

export function createPressGuards(): PressGuards {
  const salt = randomBytes(16);
  const hits = new Map<string, number[]>(); // hashed key to press times in the last hour, oldest first
  const inFlight = new Map<string, number>(); // hashed key to presses running now
  let day = "";
  let dayCount = 0;

  const hashOf = (clientKey: string) => createHash("sha256").update(salt).update(clientKey).digest("base64url");

  const recent = (id: string, nowMs: number): number[] => {
    const times = hits.get(id);
    if (!times) return [];
    while (times.length > 0 && times[0] <= nowMs - HOUR_MS) times.shift();
    if (times.length === 0) hits.delete(id);
    return times;
  };

  const rollDay = (nowMs: number) => {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      dayCount = 0;
    }
  };

  const makeRoom = (nowMs: number) => {
    if (hits.size < MAX_TRACKED_KEYS) return;
    for (const id of [...hits.keys()]) recent(id, nowMs);
    for (const id of hits.keys()) {
      if (hits.size < MAX_TRACKED_KEYS) break;
      hits.delete(id); // the oldest key first, Map keeps insertion order
    }
  };

  const guards: PressGuards = {
    checkHourly(clientKey, nowMs, perHour) {
      if (perHour <= 0) return { ok: true };
      const times = recent(hashOf(clientKey), nowMs);
      if (times.length < perHour) return { ok: true };
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((times[0] + HOUR_MS - nowMs) / 1000)) };
    },
    dailyCapReached(nowMs, cap) {
      rollDay(nowMs);
      return dayCount >= cap;
    },
    count(clientKey, nowMs, perHour) {
      rollDay(nowMs);
      dayCount += 1;
      if (perHour <= 0) return;
      const id = hashOf(clientKey);
      const times = recent(id, nowMs);
      if (times.length === 0) {
        makeRoom(nowMs);
        hits.set(id, [nowMs]);
      } else {
        times.push(nowMs);
      }
    },
    admit(clientKey, nowMs, perHour, cap) {
      const hourly = guards.checkHourly(clientKey, nowMs, perHour);
      if (!hourly.ok) return { ok: false, code: "rate_limited", retryAfterSec: hourly.retryAfterSec };
      if (guards.dailyCapReached(nowMs, cap)) return { ok: false, code: "daily_cap" };
      guards.count(clientKey, nowMs, perHour);
      return { ok: true };
    },
    enter(clientKey, max = MAX_IN_FLIGHT) {
      const id = hashOf(clientKey);
      const running = inFlight.get(id) ?? 0;
      if (running >= max) return null;
      inFlight.set(id, running + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (inFlight.get(id) ?? 1) - 1;
        if (left > 0) inFlight.set(id, left);
        else inFlight.delete(id);
      };
    },
    reset() {
      hits.clear();
      inFlight.clear();
      day = "";
      dayCount = 0;
    },
  };
  return guards;
}

/** One set of guards per server instance. */
export const pressGuards = createPressGuards();
