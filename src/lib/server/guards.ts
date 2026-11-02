// Press guards (ux-spec 9 item 3), the demo guard next to the LIVE_ENABLED kill switch. Server only.
// Best effort and in memory. Each server instance keeps its own counts and a cold start resets them,
// so this caps spend on a demo, it is not a global quota. Live presses only, mock never counts.
// Client keys are kept as salted hashes for at most an hour and are never logged.
import { createHash, randomBytes } from "node:crypto";

const HOUR_MS = 3_600_000;
const MAX_TRACKED_KEYS = 10_000;

export type HourlyCheck = { ok: true } | { ok: false; retryAfterSec: number };

export interface PressGuards {
  /** perHour 0 turns the per-client limit off. */
  checkHourly(clientKey: string, nowMs: number, perHour: number): HourlyCheck;
  /** True when this instance already ran cap live presses in the current UTC day. */
  dailyCapReached(nowMs: number, cap: number): boolean;
  /** Counts one live press toward both guards, once its body passed and a provider is about to run. */
  count(clientKey: string, nowMs: number, perHour: number): void;
  reset(): void;
}

export function createPressGuards(): PressGuards {
  const salt = randomBytes(16);
  const hits = new Map<string, number[]>(); // hashed key to press times in the last hour, oldest first
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

  return {
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
    reset() {
      hits.clear();
      day = "";
      dayCount = 0;
    },
  };
}

/** One set of guards per server instance. */
export const pressGuards = createPressGuards();
