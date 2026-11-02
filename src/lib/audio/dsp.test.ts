import { describe, expect, it } from "vitest";
import { LIMITS, checkClipWav, inspectWav } from "../protocol";
import { buildClipSlice, isPartial, roundSec, sliceFrames } from "./clip";
import { GATE, silenceGate } from "./gate";
import { LevelMeter, NORMALIZE, SPEECH_RMS, measureLevel, normalizeInPlace } from "./level";
import { resample, resampledLength } from "./resample";
import { encodeWavPcm16, wavSeconds } from "./wav";
import { voice } from "./worklet-harness";

function sine(freq: number, seconds: number, rate: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

function noise(seconds: number, rate: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out[i] = amplitude * ((x / 2147483648) * 2 - 1);
  }
  return out;
}

describe("WAV encoding", () => {
  it("writes 16 kHz mono PCM16 that checkClipWav accepts", () => {
    const wav = encodeWavPcm16(voice(30, 16_000), 16_000);
    expect(wav.byteLength).toBe(960_044);
    const check = checkClipWav(wav);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.wav.sampleRate).toBe(LIMITS.sampleRate);
      expect(check.wav.channels).toBe(1);
      expect(check.wav.bitsPerSample).toBe(16);
      expect(check.wav.seconds).toBeCloseTo(30, 6);
    }
    expect(wavSeconds(wav.byteLength)).toBeCloseTo(30, 6);
  });

  it("keeps 120 s under the body cap", () => {
    const wav = encodeWavPcm16(new Float32Array(120 * 16_000));
    expect(wav.byteLength).toBe(3_840_044);
    expect(wav.byteLength).toBeLessThan(LIMITS.maxBodyBytes);
    expect(checkClipWav(wav).ok).toBe(true);
  });

  it("clamps, rounds and writes little-endian samples", () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5, Number.NaN]));
    const info = inspectWav(wav);
    expect(info.ok).toBe(true);
    const view = new DataView(wav, 44);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => view.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 32767, -32768, 16384, 0]);
  });

  it("encodes a 120 s clip fast enough for the press budget", () => {
    const pcm = voice(120, 16_000);
    const started = performance.now();
    encodeWavPcm16(pcm);
    // The budget is 50 ms on a laptop. Allow slack for a loaded test machine.
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("level and normalization", () => {
  it("measures peak and rms", () => {
    const level = measureLevel(new Float32Array([0.5, -0.5, 0.5, -0.5]));
    expect(level.peak).toBeCloseTo(0.5, 6);
    expect(level.rms).toBeCloseTo(0.5, 6);
    expect(measureLevel(new Float32Array(0))).toEqual({ peak: 0, rms: 0 });
  });

  it("brings the peak to about -1 dBFS", () => {
    const x = sine(440, 1, 16_000, 0.2);
    const gain = normalizeInPlace(x);
    expect(gain).toBeCloseTo(NORMALIZE.targetPeak / 0.2, 2);
    expect(measureLevel(x).peak).toBeCloseTo(NORMALIZE.targetPeak, 2);
  });

  it("caps the boost at +20 dB and leaves silence alone", () => {
    const quiet = sine(440, 1, 16_000, 0.01);
    expect(normalizeInPlace(quiet)).toBe(NORMALIZE.maxGain);
    expect(measureLevel(quiet).peak).toBeCloseTo(0.1, 2);
    const silent = new Float32Array(1600);
    expect(normalizeInPlace(silent)).toBe(1);
    expect(silent.every((v) => v === 0)).toBe(true);
  });

  it("turns worklet levels into readings with memory seconds and the quiet hint", () => {
    const meter = new LevelMeter(120);
    meter.reset(0);
    const loud = meter.reading({ rms: 0.05, peak: 0.2, sinceGap: 16_000 * 10, sampleRate: 16_000 }, 1_000);
    expect(loud).toMatchObject({ at: 1_000, speech: true, memorySec: 10, quiet: false });
    const capped = meter.reading({ rms: 0, peak: 0, sinceGap: 16_000 * 500, sampleRate: 16_000 }, 2_000);
    expect(capped.memorySec).toBe(120);
    expect(capped.speech).toBe(false);
    expect(meter.reading({ rms: SPEECH_RMS / 2, peak: 0, sinceGap: 0, sampleRate: 16_000 }, 1_000 + LIMITS.quietHintMs).quiet).toBe(
      true,
    );
    expect(meter.reading({ rms: 2, peak: Number.NaN, sinceGap: 0, sampleRate: 16_000 }, 50_000)).toMatchObject({ rms: 1, peak: 0 });
  });
});

describe("silence gate", () => {
  it("holds back silence and a low noise floor", () => {
    expect(silenceGate(new Float32Array(16_000 * 30), 16_000).silent).toBe(true);
    expect(silenceGate(noise(30, 16_000, 0.002), 16_000).silent).toBe(true);
  });

  it("ignores a DC offset", () => {
    expect(silenceGate(new Float32Array(16_000 * 5).fill(0.05), 16_000).silent).toBe(true);
  });

  it("lets soft far-field speech through", () => {
    const soft = voice(30, 16_000, 0.012); // about -45 dBFS rms
    expect(silenceGate(soft, 16_000).silent).toBe(false);
  });

  it("needs a little speech, not a single click", () => {
    const x = new Float32Array(16_000 * 30);
    x.set(voice(0.1, 16_000), 1000);
    expect(silenceGate(x, 16_000).silent).toBe(true);
    x.set(voice(0.5, 16_000), 100_000);
    const verdict = silenceGate(x, 16_000);
    expect(verdict.activeMs).toBeGreaterThanOrEqual(GATE.minActiveMs);
    expect(verdict.silent).toBe(false);
  });
});

describe("resampling", () => {
  it("keeps a 1 kHz tone from 48 kHz to 16 kHz", () => {
    const out = resample(sine(1000, 2, 48_000), 48_000, 16_000);
    expect(out.length).toBe(32_000);
    const ideal = sine(1000, 2, 16_000);
    let maxErr = 0;
    for (let i = 200; i < out.length - 200; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - ideal[i]));
    expect(maxErr).toBeLessThan(0.01);
  });

  it("keeps a 1 kHz tone from 44.1 kHz to 16 kHz", () => {
    const out = resample(sine(1000, 2, 44_100), 44_100, 16_000);
    expect(out.length).toBe(resampledLength(88_200, 44_100, 16_000));
    expect(out.length).toBe(32_000);
    const ideal = sine(1000, 2, 16_000);
    let maxErr = 0;
    for (let i = 200; i < out.length - 200; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - ideal[i]));
    expect(maxErr).toBeLessThan(0.01);
  });

  it("removes content above the new Nyquist instead of folding it back", () => {
    const out = resample(sine(9_000, 1, 48_000), 48_000, 16_000);
    expect(rms(out, 200, out.length - 200)).toBeLessThan(0.005);
  });

  it("upsamples and copies when the rates match", () => {
    const up = resample(sine(500, 1, 8_000), 8_000, 16_000);
    expect(up.length).toBe(16_000);
    expect(rms(up, 200, 15_800)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    const same = new Float32Array([0.1, 0.2]);
    const copy = resample(same, 16_000, 16_000);
    expect(copy).toEqual(same);
    expect(copy).not.toBe(same);
    expect(resample(new Float32Array(0), 48_000, 16_000).length).toBe(0);
  });

  it("handles an unusual device rate", () => {
    const out = resample(sine(1000, 1, 47_999), 47_999, 16_000);
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);
    expect(rms(out, 200, out.length - 200)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });
});

describe("slicing a snapshot", () => {
  it("takes the last window, or all of memory when it holds less", () => {
    expect(sliceFrames(16_000 * 120, 16_000, 30)).toEqual({ start: 16_000 * 90, frames: 16_000 * 30 });
    expect(sliceFrames(16_000 * 12, 16_000, 30)).toEqual({ start: 0, frames: 16_000 * 12 });
    expect(sliceFrames(48_000 * 70, 48_000, 60)).toEqual({ start: 48_000 * 10, frames: 48_000 * 60 });
    expect(sliceFrames(0, 16_000, 30)).toEqual({ start: 0, frames: 0 });
    expect(roundSec(12.3456)).toBe(12.35);
    expect(isPartial({ sentSec: 12, windowSec: 30 })).toBe(true);
    expect(isPartial({ sentSec: 30, windowSec: 30 })).toBe(false);
  });

  it("builds a normalized 16 kHz WAV from the newest audio and leaves the snapshot alone", () => {
    const pcm = new Float32Array(16_000 * 50);
    pcm.set(voice(30, 16_000, 0.1), 16_000 * 20);
    const before = pcm.slice();
    const slice = buildClipSlice(pcm, 16_000, 30);
    let changed = 0;
    for (let i = 0; i < pcm.length; i++) if (pcm[i] !== before[i]) changed++;
    expect(changed).toBe(0);
    expect(slice).toMatchObject({ windowSec: 30, sentSec: 30, silent: false });
    expect(slice.bytes).toBe(slice.wav.byteLength);
    expect(slice.peak).toBeCloseTo(0.1, 2);
    const check = checkClipWav(slice.wav);
    expect(check.ok).toBe(true);
    const samples = new Int16Array(slice.wav, 44);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    expect(peak / 32768).toBeCloseTo(NORMALIZE.targetPeak, 1);
  });

  it("resamples a native-rate snapshot and reports a partial window", () => {
    const slice = buildClipSlice(voice(12, 48_000), 48_000, 30);
    expect(slice.sentSec).toBe(12);
    expect(isPartial(slice)).toBe(true);
    const check = checkClipWav(slice.wav);
    expect(check.ok && check.wav.sampleRate).toBe(16_000);
    expect(check.ok && check.wav.seconds).toBeCloseTo(12, 3);
  });

  it("marks a quiet window silent but still encodes it for Send anyway", () => {
    const slice = buildClipSlice(noise(40, 16_000, 0.001), 16_000, 30);
    expect(slice.silent).toBe(true);
    expect(checkClipWav(slice.wav).ok).toBe(true);
  });

  it("slices, normalizes and encodes 30 s within the press budget", () => {
    const pcm = voice(120, 16_000);
    const started = performance.now();
    buildClipSlice(pcm, 16_000, 30);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
