// From a frozen snapshot to the bytes a press sends (ux-spec 9 item 2). Pure, no DOM.
// Slice the last windowSec seconds, resample to 16 kHz when the context ran at its native rate,
// measure, run the silence gate, peak-normalize and encode PCM16 WAV. The snapshot is never
// modified, and the float working copy is zeroed once the WAV exists.
import type { WindowSec } from "../card/schema";
import { LIMITS } from "../protocol";
import { silenceGate } from "./gate";
import { measureLevel, normalizeInPlace } from "./level";
import { resample } from "./resample";
import type { ClipSlice } from "./types";
import { encodeWavPcm16 } from "./wav";

export interface FrameRange {
  start: number;
  frames: number;
}

/** The last windowSec seconds of totalFrames, or all of them when memory holds less. */
export function sliceFrames(totalFrames: number, sampleRate: number, windowSec: number): FrameRange {
  const want = Math.max(0, Math.round(windowSec * sampleRate));
  const frames = Math.min(Math.max(0, totalFrames), want);
  return { start: Math.max(0, totalFrames) - frames, frames };
}

/** Seconds as sent, rounded to 10 ms. */
export function roundSec(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

/** True when the slice holds less than its window (memory was not full yet). */
export function isPartial(slice: Pick<ClipSlice, "sentSec" | "windowSec">): boolean {
  return slice.sentSec < slice.windowSec - 0.05;
}

export function buildClipSlice(pcm: Float32Array, sampleRate: number, windowSec: WindowSec): ClipSlice {
  const { start, frames } = sliceFrames(pcm.length, sampleRate, windowSec);
  const segment = pcm.subarray(start, start + frames);
  const work = Math.round(sampleRate) === LIMITS.sampleRate ? segment.slice() : resample(segment, sampleRate, LIMITS.sampleRate);
  const { peak, rms } = measureLevel(work);
  const { silent } = silenceGate(work, LIMITS.sampleRate);
  normalizeInPlace(work, peak);
  const wav = encodeWavPcm16(work, LIMITS.sampleRate);
  const sentSec = roundSec(work.length / LIMITS.sampleRate);
  work.fill(0);
  return { wav, windowSec, sentSec, bytes: wav.byteLength, peak, rms, silent };
}
