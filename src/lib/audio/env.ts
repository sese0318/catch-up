// The browser surface the capture engine touches, as small structural types. The engine only talks
// to a CaptureEnv, so tests can drive it with fakes. browserCaptureEnv() reads the live browser and
// is called lazily, at the first start(), never at import time.
import { getDesktopBridge } from "./types";
import { readBrowserSupport } from "./support";

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

export interface AudioBufferLike {
  readonly duration: number;
}

export interface BufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface WorkletNodeLike extends AudioNodeLike {
  readonly port: MessagePortLike;
}

export interface MediaStreamTrackLike {
  readonly kind: string;
  readonly readyState: string;
  stop(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface MediaStreamLike {
  getAudioTracks(): MediaStreamTrackLike[];
  getVideoTracks(): MediaStreamTrackLike[];
}

export interface AudioContextLike {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  readonly audioWorklet?: { addModule(url: string): Promise<void> };
  createGain(): GainNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createBufferSource(): BufferSourceNodeLike;
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
}

export interface WorkletNodeOptions {
  numberOfInputs: number;
  numberOfOutputs: number;
  outputChannelCount: number[];
  channelCount: number;
  channelCountMode: "explicit";
  channelInterpretation: "speakers";
  processorOptions: { seconds: number };
}

export interface WakeLockLike {
  release(): Promise<void>;
}

export interface VisibilityLike {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface CaptureEnv {
  readonly secureContext: boolean;
  readonly phone: boolean; // wake lock, and pause with reason interrupted when hidden
  readonly nativeRate: boolean; // WebKit, run the context at its native rate
  readonly desktopApp: boolean; // the Windows app bridge exists
  /** sampleRate null means the device rate. Throws when Web Audio is missing. */
  createAudioContext(sampleRate: number | null): AudioContextLike;
  createWorkletNode(ctx: AudioContextLike, name: string, options: WorkletNodeOptions): WorkletNodeLike;
  /** Both must call the browser synchronously, so the prompt keeps the click's activation. */
  getUserMedia: ((constraints: MediaStreamConstraints) => Promise<MediaStreamLike>) | null;
  getDisplayMedia: ((options: object) => Promise<MediaStreamLike>) | null;
  /** A CaptureController set to no-focus-change, or undefined where it does not exist. */
  createCaptureController(): unknown;
  fetchBytes(url: string): Promise<ArrayBuffer>;
  requestWakeLock: (() => Promise<WakeLockLike>) | null;
  visibility: VisibilityLike | null;
}

type FocusController = { setFocusBehavior?(behavior: string): void };

export function browserCaptureEnv(): CaptureEnv {
  const support = readBrowserSupport(getDesktopBridge() !== null);
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { wakeLock?: WakeLock }) : undefined;
  return {
    secureContext: support.secureContext,
    phone: support.phone,
    nativeRate: support.nativeRate,
    desktopApp: support.desktopApp,
    createAudioContext(sampleRate) {
      const options: AudioContextOptions = { latencyHint: "playback" };
      if (sampleRate) options.sampleRate = sampleRate;
      return new AudioContext(options) as unknown as AudioContextLike;
    },
    createWorkletNode(ctx, name, options) {
      return new AudioWorkletNode(ctx as unknown as BaseAudioContext, name, options) as unknown as WorkletNodeLike;
    },
    getUserMedia:
      typeof media?.getUserMedia === "function"
        ? (constraints) => media.getUserMedia(constraints) as Promise<MediaStreamLike>
        : null,
    getDisplayMedia:
      typeof media?.getDisplayMedia === "function"
        ? (options) => media.getDisplayMedia(options as DisplayMediaStreamOptions) as Promise<MediaStreamLike>
        : null,
    createCaptureController() {
      const Ctor = (globalThis as { CaptureController?: new () => FocusController }).CaptureController;
      if (typeof Ctor !== "function") return undefined;
      const controller = new Ctor();
      try {
        controller.setFocusBehavior?.("no-focus-change"); // Catch Up stays in front after the pick
      } catch {
        // older engines without setFocusBehavior
      }
      return controller;
    },
    async fetchBytes(url) {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`sample request failed with ${res.status}`);
      return res.arrayBuffer();
    },
    requestWakeLock: nav?.wakeLock ? () => nav.wakeLock!.request("screen") : null,
    visibility: typeof document !== "undefined" ? document : null,
  };
}
