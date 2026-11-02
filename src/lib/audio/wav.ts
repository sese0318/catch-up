// Mono 16-bit PCM WAV writer (browser-audio.md 3.5). Pure, no DOM.
// The canonical 44-byte layout. 30 s at 16 kHz is 960,044 bytes, 120 s is 3,840,044 bytes.
import { LIMITS } from "../protocol";

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Float samples in [-1, 1] to a mono PCM16 WAV. Values outside the range are clamped. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number = LIMITS.sampleRate): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(LIMITS.wavHeaderBytes + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size for PCM
  view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  if (LITTLE_ENDIAN) {
    const out = new Int16Array(buffer, LIMITS.wavHeaderBytes, samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = toInt16(samples[i]);
  } else {
    let offset = LIMITS.wavHeaderBytes;
    for (let i = 0; i < samples.length; i++, offset += 2) view.setInt16(offset, toInt16(samples[i]), true);
  }
  return buffer;
}

function toInt16(sample: number): number {
  const s = sample > 1 ? 1 : sample < -1 ? -1 : sample;
  if (s !== s) return 0; // NaN
  return Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
}

/** Seconds of audio a PCM16 mono WAV of this many bytes holds. */
export function wavSeconds(bytes: number, sampleRate: number = LIMITS.sampleRate): number {
  return Math.max(0, bytes - LIMITS.wavHeaderBytes) / (sampleRate * 2);
}
