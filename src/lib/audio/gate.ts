// Local silence gate (ux-spec 5 Privacy UX item 4). Pure, no DOM.
// No speech energy means no request. The gate is conservative, so soft far-field speech still
// passes, and Send anyway covers the rest. It runs on the clip before normalization.
import { SPEECH_RMS } from "./level";

export const GATE = {
  frameMs: 20,
  activeRms: SPEECH_RMS, // per 20 ms frame, DC removed
  minActiveMs: 300, // less speech energy than this in the whole window counts as silence
} as const;

export interface GateVerdict {
  silent: boolean;
  activeMs: number; // milliseconds of frames above GATE.activeRms
}

export function silenceGate(samples: Float32Array, sampleRate: number): GateVerdict {
  const frame = Math.max(1, Math.round((sampleRate * GATE.frameMs) / 1000));
  let active = 0;
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0;
    let sumSq = 0;
    for (let i = start; i < start + frame; i++) {
      const s = samples[i];
      sum += s;
      sumSq += s * s;
    }
    const mean = sum / frame;
    const variance = sumSq / frame - mean * mean; // AC energy, so a DC offset never reads as speech
    if (variance > 0 && Math.sqrt(variance) >= GATE.activeRms) active++;
  }
  const activeMs = active * GATE.frameMs;
  return { silent: activeMs < GATE.minActiveMs, activeMs };
}
