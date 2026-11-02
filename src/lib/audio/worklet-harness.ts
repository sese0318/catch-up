// Test helper. Runs public/worklets/catchup-ring.js in Node with a fake AudioWorkletGlobalScope,
// so tests exercise the real processor code. Never imported by app code.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: unknown[]): void;
}

export interface RingProcessor {
  port: FakePort;
  capacity: number;
  buf: Float32Array;
  filled: number;
  sinceGap: number;
  feeding: boolean;
  epoch: number;
  process(inputs: Float32Array[][]): boolean;
}

type ProcessorCtor = new (options?: { processorOptions?: { seconds?: number } }) => RingProcessor;

const WORKLET_PATH = fileURLToPath(new URL("../../../public/worklets/catchup-ring.js", import.meta.url));

/**
 * Loads the processor class for one sample rate. outbox receives everything the processor posts,
 * and setDeliver redirects it (the engine tests forward it to a fake AudioWorkletNode).
 */
export function loadRingProcessor(sampleRate: number): {
  create(seconds?: number): { processor: RingProcessor; outbox: unknown[]; setDeliver(fn: (data: unknown) => void): void };
} {
  const source = readFileSync(WORKLET_PATH, "utf8");
  let registered: ProcessorCtor | null = null;
  let nextPort: FakePort | null = null;
  class FakeProcessorBase {
    port: FakePort;
    constructor() {
      if (!nextPort) throw new Error("no port for this processor");
      this.port = nextPort;
      nextPort = null;
    }
  }
  const register = (name: string, ctor: ProcessorCtor) => {
    if (name !== "catchup-ring") throw new Error(`unexpected processor ${name}`);
    registered = ctor;
  };
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentFrame", "currentTime", source)(
    FakeProcessorBase,
    register,
    sampleRate,
    0,
    0,
  );
  if (!registered) throw new Error("catchup-ring was not registered");
  const Ctor: ProcessorCtor = registered;
  return {
    create(seconds?: number) {
      const outbox: unknown[] = [];
      let deliver: ((data: unknown) => void) | null = null;
      const port: FakePort = {
        onmessage: null,
        postMessage(message) {
          outbox.push(message);
          deliver?.(message);
        },
      };
      nextPort = port;
      const processor = new Ctor({ processorOptions: seconds === undefined ? {} : { seconds } });
      return { processor, outbox, setDeliver: (fn) => (deliver = fn) };
    },
  };
}

/** Feeds frames to the processor in render quanta (128 by default). */
export function feed(processor: RingProcessor, samples: Float32Array, quantum = 128): void {
  for (let i = 0; i < samples.length; i += quantum) {
    processor.process([[samples.subarray(i, Math.min(samples.length, i + quantum))]]);
  }
}

/** A speech-like test signal. A 220 Hz tone with a slow envelope, amplitude about 0.3. */
export function voice(seconds: number, sampleRate: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const envelope = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t);
    out[i] = amplitude * envelope * Math.sin(2 * Math.PI * 220 * t);
  }
  return out;
}
