// Band-limited resampler for contexts that run at their native rate (Safari and every iPhone
// browser, browser-audio.md 3.1 and 3.4). Pure, no DOM, deterministic. A polyphase windowed sinc
// (Kaiser, about 55 dB) with a cutoff at 0.42 of the lower rate, so 48 kHz to 16 kHz keeps speech
// up to about 5.5 kHz and nothing folds back below 7.9 kHz. Only the sliced window is resampled.

const MAX_PHASES = 1024;
const STOPBAND_DB = 55;
const TRANSITION_HZ = 2400;
const CUTOFF_RATIO = 0.42;

interface Kernel {
  up: number;
  down: number;
  exact: boolean; // one phase per output position, otherwise phases are quantized
  phases: number;
  half: number; // taps on each side
  taps: number;
  table: Float32Array; // phases x taps, each phase sums to 1
}

const kernels = new Map<string, Kernel>();

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

function kernelFor(from: number, to: number): Kernel {
  const key = `${from}:${to}`;
  const cached = kernels.get(key);
  if (cached) return cached;
  const g = gcd(from, to);
  const up = to / g;
  const down = from / g;
  const exact = up <= MAX_PHASES;
  const phases = exact ? up : MAX_PHASES;
  const fc = (CUTOFF_RATIO * Math.min(from, to)) / from; // cycles per input sample
  const length = Math.ceil((STOPBAND_DB - 8) / (14.36 * (TRANSITION_HZ / from)));
  const half = Math.max(2, Math.ceil(length / 2));
  const taps = 2 * half;
  const beta = 0.1102 * (STOPBAND_DB - 8.7);
  const norm = besselI0(beta);
  const table = new Float32Array(phases * taps);
  for (let p = 0; p < phases; p++) {
    const frac = p / phases;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const d = frac + half - 1 - k; // distance from the output point to this tap, in input samples
      const r = d / half;
      const w = r * r < 1 ? besselI0(beta * Math.sqrt(1 - r * r)) / norm : 0;
      const x = 2 * fc * d;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const h = 2 * fc * sinc * w;
      table[p * taps + k] = h;
      sum += h;
    }
    if (sum !== 0) for (let k = 0; k < taps; k++) table[p * taps + k] /= sum;
  }
  const kernel: Kernel = { up, down, exact, phases, half, taps, table };
  kernels.set(key, kernel);
  return kernel;
}

/** Output length for an input of this many frames. */
export function resampledLength(frames: number, fromRate: number, toRate: number): number {
  const from = Math.round(fromRate);
  const to = Math.round(toRate);
  if (from === to) return frames;
  return Math.floor((frames * to) / from);
}

/** Returns a new array at toRate. The input is never modified. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const from = Math.round(fromRate);
  const to = Math.round(toRate);
  if (from === to) return input.slice();
  if (input.length === 0 || from <= 0 || to <= 0) return new Float32Array(0);
  const k = kernelFor(from, to);
  const outLen = resampledLength(input.length, from, to);
  const out = new Float32Array(outLen);
  const { half, taps, table } = k;
  const padded = new Float32Array(input.length + 2 * half + 1);
  padded.set(input, half);
  for (let j = 0; j < outLen; j++) {
    let n0: number;
    let p: number;
    if (k.exact) {
      const pos = j * k.down;
      n0 = Math.floor(pos / k.up);
      p = pos - n0 * k.up;
    } else {
      const t = (j * from) / to;
      n0 = Math.floor(t);
      p = Math.round((t - n0) * k.phases);
      if (p === k.phases) {
        n0++;
        p = 0;
      }
    }
    // Tap i reads input n0 - half + 1 + i, which sits at padded index n0 + 1 + i.
    let x = n0 + 1;
    let h = p * taps;
    const end = h + taps; // taps is even, so pairs never run past it
    let acc0 = 0;
    let acc1 = 0;
    while (h < end) {
      acc0 += padded[x] * table[h];
      acc1 += padded[x + 1] * table[h + 1];
      x += 2;
      h += 2;
    }
    out[j] = acc0 + acc1;
  }
  padded.fill(0); // the copy held audio
  return out;
}
