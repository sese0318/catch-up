// Sample playback helpers (ux-spec 3 Sample flow). Pure, no DOM.
// The speaker path is muffled (lowpass plus lower gain) inside the muffle window to simulate
// zoning out. The ring always gets the clean audio.
import type { MuffleWindow } from "./types";

export const MUFFLE = {
  lowpassHz: 450,
  gain: 0.3,
  rampSec: 0.3,
} as const;

/** Seconds between sample progress events while a clip plays. */
export const SAMPLE_TICK_MS = 250;

export interface MufflePlan {
  startSec: number; // ramp down starts
  fullSec: number; // fully muffled
  releaseSec: number; // ramp up starts
  endSec: number; // clear again
}

/** The automation for a muffle window clamped to the clip, or null when there is nothing to muffle. */
export function planMuffle(muffle: MuffleWindow | undefined, durationSec: number): MufflePlan | null {
  if (!muffle || !(durationSec > 0)) return null;
  const start = clamp(muffle.startSec, 0, durationSec);
  const end = clamp(muffle.endSec, 0, durationSec);
  if (!(end - start > 0.05)) return null;
  const ramp = Math.min(MUFFLE.rampSec, (end - start) / 2);
  return { startSec: start, fullSec: start + ramp, releaseSec: end - ramp, endSec: end };
}

export function sampleStateAt(
  spec: { muffle?: MuffleWindow; keyMomentSec?: number },
  currentSec: number,
): { muffled: boolean; keyMomentPassed: boolean } {
  const m = spec.muffle;
  return {
    muffled: !!m && currentSec >= m.startSec && currentSec < m.endSec,
    keyMomentPassed: spec.keyMomentSec !== undefined && currentSec >= spec.keyMomentSec,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
}
