// Clip level, peak normalization and the live level meter. Pure, no DOM.
import { LIMITS } from "../protocol";
import type { LevelReading } from "./types";

/** RMS above this (about -50 dBFS) counts as speech energy, for the meter and the silence gate. */
export const SPEECH_RMS = 0.003;

/** Peak normalization target (about -1 dBFS) and the largest boost (+20 dB). */
export const NORMALIZE = { targetPeak: 0.89, maxGain: 10, minPeak: 1e-4 } as const;

export interface ClipLevel {
  peak: number; // 0 to 1
  rms: number;
}

export function measureLevel(samples: Float32Array): ClipLevel {
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  return { peak: Math.min(1, peak), rms: samples.length ? Math.min(1, Math.sqrt(sumSq / samples.length)) : 0 };
}

/**
 * Scales the clip in place so its peak sits near -1 dBFS, at most +20 dB. Replaces browser AGC,
 * which pumps during pauses. Returns the gain applied. A near-silent clip is left alone.
 */
export function normalizeInPlace(samples: Float32Array, peak: number = measureLevel(samples).peak): number {
  if (peak < NORMALIZE.minPeak) return 1;
  const gain = Math.min(NORMALIZE.targetPeak / peak, NORMALIZE.maxGain);
  if (gain !== 1) for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return gain;
}

/** One level message from the catchup-ring worklet. */
export interface WorkletLevel {
  rms: number;
  peak: number;
  sinceGap: number; // frames since start, the last gap or the last clear
  sampleRate: number;
}

/** Turns worklet level messages into LevelReadings, tracking how long it has been quiet. */
export class LevelMeter {
  private lastSpeechAt = 0;

  constructor(private readonly memoryCapSec: number = LIMITS.memorySec) {}

  /** Call when listening starts or memory restarts after a pause. */
  reset(now: number): void {
    this.lastSpeechAt = now;
  }

  reading(level: WorkletLevel, now: number): LevelReading {
    const rms = clamp01(level.rms);
    const peak = clamp01(level.peak);
    const speech = rms >= SPEECH_RMS;
    if (speech) this.lastSpeechAt = now;
    const memorySec = level.sampleRate > 0 ? Math.min(this.memoryCapSec, level.sinceGap / level.sampleRate) : 0;
    return { at: now, rms, peak, speech, memorySec, quiet: now - this.lastSpeechAt >= LIMITS.quietHintMs };
  }
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
