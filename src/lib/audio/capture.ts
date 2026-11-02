// Capture engine core (ux-spec 3 and 9 item 1, browser-audio.md 1 to 3 and 5). Browser glue
// behind the CaptureEnv seam. engine.ts wires it to the live browser.
//
// One AudioContext (16 kHz, or the device rate on WebKit) and one catchup-ring AudioWorklet node
// that holds the last 120 s. One source at a time. Every paused state has zeroed the ring and every
// snapshot. A finished sample stays listening with endedAt set until a new start(), pause() or
// LIMITS.snapshotHoldMs later, then pauses with reason sample_ended.
import type { WindowSec } from "../card/schema";
import { LIMITS } from "../protocol";
import { buildClipSlice } from "./clip";
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  BufferSourceNodeLike,
  CaptureEnv,
  GainNodeLike,
  MediaStreamLike,
  MediaStreamTrackLike,
  WakeLockLike,
  WorkletNodeLike,
} from "./env";
import { randomId } from "./ids";
import { LevelMeter } from "./level";
import { MUFFLE, SAMPLE_TICK_MS, planMuffle, sampleStateAt } from "./sample";
import { captureErrorCode, displayMediaOptions, micConstraints } from "./sources";
import {
  CaptureError,
  WORKLET_URL,
  type CaptureEngine,
  type CaptureEngineOptions,
  type CaptureErrorCode,
  type CaptureEvent,
  type CaptureSourceKind,
  type CaptureSourceSpec,
  type CaptureStatus,
  type ClipSlice,
  type LevelReading,
  type PauseReason,
  type Snapshot,
} from "./types";

export const WORKLET_PROCESSOR = "catchup-ring";
export const SNAPSHOT_TIMEOUT_MS = 3_000;
const CLEAR_ACK_TIMEOUT_MS = 1_000;
const SAMPLE_START_DELAY_SEC = 0.05;

type Timer = ReturnType<typeof setTimeout>;
type SampleSpec = Extract<CaptureSourceSpec, { kind: "sample" }>;
type StreamSpec = Exclude<CaptureSourceSpec, { kind: "sample" }>;

interface SampleRun {
  spec: SampleSpec;
  ctx: AudioContextLike;
  source: BufferSourceNodeLike;
  t0: number; // context time the clip starts
  duration: number;
  tick: ReturnType<typeof setInterval> | null;
}

interface Session {
  gen: number;
  startedAt: number;
  stream: MediaStreamLike | null;
  nodes: AudioNodeLike[];
  cleanups: Array<() => void>;
  sample: SampleRun | null;
  endedAt: number | null;
  hold: Timer | null;
  wakeLock: WakeLockLike | null;
}

type WorkletMessage =
  | { type: "level"; epoch: number; rms: number; peak: number; filled: number; sinceGap: number; sampleRate: number }
  | { type: "snapshot"; id: number; epoch: number; sampleRate: number; frames: number; gapCut: boolean; pcm: Float32Array }
  | { type: "cleared"; epoch: number };

interface SnapshotWaiter {
  epoch: number;
  gen: number;
  source: CaptureSourceKind;
  timer: Timer;
  resolve(snapshot: Snapshot): void;
  reject(error: Error): void;
}

const noop = () => undefined;

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // a failing listener or an already closed node never stops the rest
  }
}

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "";
}

function liveAudioTrack(stream: MediaStreamLike): MediaStreamTrackLike | null {
  return stream.getAudioTracks().find((t) => t.readyState === "live") ?? null;
}

/** Audio first, then video, so a share never keeps a muted capture open. */
function stopStream(stream: MediaStreamLike): void {
  for (const t of stream.getAudioTracks()) safe(() => t.stop());
  for (const t of stream.getVideoTracks()) safe(() => t.stop());
}

function isSnapshotMessage(data: unknown): data is Extract<WorkletMessage, { type: "snapshot" }> {
  return !!data && (data as { type?: unknown }).type === "snapshot" && (data as { pcm?: unknown }).pcm instanceof Float32Array;
}

class HeldSnapshot implements Snapshot {
  readonly id: string;
  readonly takenAt: number;
  readonly memorySec: number;
  readonly source: CaptureSourceKind;
  readonly gapCut: boolean;
  private pcm: Float32Array | null;
  private readonly rate: number;
  private timer: Timer | null;
  private readonly onRelease: (snapshot: HeldSnapshot) => void;

  constructor(init: {
    pcm: Float32Array;
    sampleRate: number;
    gapCut: boolean;
    source: CaptureSourceKind;
    onRelease: (snapshot: HeldSnapshot) => void;
  }) {
    this.id = `snap_${randomId(9)}`;
    this.takenAt = Date.now();
    this.pcm = init.pcm;
    this.rate = init.sampleRate;
    this.memorySec = init.sampleRate > 0 ? init.pcm.length / init.sampleRate : 0;
    this.source = init.source;
    this.gapCut = init.gapCut;
    this.onRelease = init.onRelease;
    this.timer = setTimeout(() => this.release(), LIMITS.snapshotHoldMs);
  }

  get released(): boolean {
    return this.pcm === null;
  }

  slice(windowSec: WindowSec): Promise<ClipSlice> {
    const pcm = this.pcm;
    if (!pcm) return Promise.reject(new Error("The snapshot was released"));
    try {
      return Promise.resolve(buildClipSlice(pcm, this.rate, windowSec));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("The clip could not be built"));
    }
  }

  release(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pcm) return;
    this.pcm.fill(0);
    this.pcm = null;
    this.onRelease(this);
  }
}

function clampMemory(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return LIMITS.memorySec;
  return Math.min(300, Math.max(LIMITS.warmupSec, seconds));
}

export class CaptureEngineCore implements CaptureEngine {
  private status: CaptureStatus = { state: "idle" };
  private spec: CaptureSourceSpec | null = null;
  private envValue: CaptureEnv | null = null;
  private ctx: AudioContextLike | null = null;
  private ctxNative = false;
  private ctxCleanup: (() => void) | null = null;
  private node: WorkletNodeLike | null = null;
  private nodeCtx: AudioContextLike | null = null;
  private nodePull: GainNodeLike | null = null;
  private moduleCtx: AudioContextLike | null = null;
  private moduleLoad: Promise<void> | null = null;
  private session: Session | null = null;
  private gen = 0;
  private epoch = 0;
  private snapSeq = 0;
  private memSec = 0;
  private readonly memorySec: number;
  private readonly workletUrl: string;
  private readonly meter: LevelMeter;
  private readonly snapshots = new Set<HeldSnapshot>();
  private readonly waiters = new Map<number, SnapshotWaiter>();
  private clearWaiters: Array<{ epoch: number; done: () => void }> = [];
  private readonly statusListeners = new Set<() => void>();
  private readonly levelListeners = new Set<(reading: LevelReading) => void>();
  private readonly eventListeners = new Set<(event: CaptureEvent) => void>();

  constructor(
    private readonly envFactory: () => CaptureEnv,
    options: CaptureEngineOptions = {},
  ) {
    this.memorySec = clampMemory(options.memorySec);
    this.workletUrl = options.workletUrl ?? WORKLET_URL;
    this.meter = new LevelMeter(this.memorySec);
  }

  getStatus(): CaptureStatus {
    return this.status;
  }

  getSource(): CaptureSourceSpec | null {
    return this.spec;
  }

  subscribe(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onLevel(listener: (reading: LevelReading) => void): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  onEvent(listener: (event: CaptureEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  memorySeconds(): number {
    return this.status.state === "listening" ? this.memSec : 0;
  }

  start(spec: CaptureSourceSpec): Promise<void> {
    let env: CaptureEnv;
    try {
      env = this.env();
    } catch {
      return this.failNow(spec, "unsupported");
    }
    // A new start replaces what runs now. Old tracks stop and memory is zeroed first.
    if (this.status.state === "starting" || this.status.state === "listening") this.pauseInternal("replaced", false);
    else this.teardown();
    const gen = ++this.gen;
    this.spec = spec;
    if (!env.secureContext) return this.failNow(spec, "insecure_context");

    // The browser prompt comes first, synchronously inside the click. Nothing is awaited before it.
    let media: Promise<MediaStreamLike> | null = null;
    if (spec.kind !== "sample") {
      try {
        media = this.requestMedia(env, spec);
      } catch (error) {
        return this.failNow(spec, captureErrorCode(error, spec.kind, env.secureContext));
      }
      media.catch(noop);
    }
    // The context is created and resumed inside the same gesture (iOS needs both).
    let ctx: AudioContextLike;
    try {
      ctx = this.ensureContext(env);
    } catch {
      void media?.then(stopStream, noop);
      return this.failNow(spec, "unsupported");
    }
    void ctx.resume().catch(noop);
    const bytes = spec.kind === "sample" ? Promise.resolve().then(() => env.fetchBytes(spec.url)) : null;
    bytes?.catch(noop);
    this.setStatus({ state: "starting", source: spec.kind });
    return this.finishStart(env, gen, spec, media, bytes);
  }

  async pause(): Promise<void> {
    const state = this.status.state;
    if (state === "idle" || state === "paused") {
      this.gen++;
      this.teardown();
      if (state === "paused") await this.suspendWhenCleared();
      return;
    }
    this.pauseInternal("user", false);
    await this.suspendWhenCleared();
  }

  async stop(): Promise<void> {
    const state = this.status.state;
    if (state === "starting" || state === "listening" || state === "error") this.pauseInternal("user", false);
    else {
      this.gen++;
      this.teardown();
    }
    const ctx = this.ctx;
    if (!ctx) return;
    const gen = this.gen;
    await this.clearAcked();
    if (this.gen !== gen || this.ctx !== ctx) return; // a new start() took over the context
    this.detachContext();
    await ctx.close().catch(noop);
  }

  snapshot(): Promise<Snapshot> {
    const status = this.status;
    const node = this.node;
    const ctx = this.ctx;
    if (status.state !== "listening" || !node || !ctx) return Promise.reject(new Error("Catch Up is not listening"));
    if (ctx.state !== "running" && ctx.state !== "closed") void ctx.resume().catch(noop); // a press is a gesture
    const id = ++this.snapSeq;
    return new Promise<Snapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiters.delete(id)) reject(new Error("The snapshot timed out"));
      }, SNAPSHOT_TIMEOUT_MS);
      this.waiters.set(id, { epoch: this.epoch, gen: this.gen, source: status.source, timer, resolve, reject });
      node.port.postMessage({ type: "snapshot", id, seconds: this.memorySec });
    });
  }

  // Start

  private env(): CaptureEnv {
    if (!this.envValue) this.envValue = this.envFactory();
    return this.envValue;
  }

  private requestMedia(env: CaptureEnv, spec: StreamSpec): Promise<MediaStreamLike> {
    if (spec.kind === "mic") {
      if (!env.getUserMedia) throw new CaptureError("unsupported", "This browser has no microphone access");
      return env.getUserMedia(micConstraints(spec));
    }
    const getDisplayMedia = env.getDisplayMedia;
    if (!getDisplayMedia) throw new CaptureError("unsupported", "This browser cannot share tab or system audio");
    const kind = spec.kind;
    if (!env.desktopApp) {
      return getDisplayMedia(displayMediaOptions(kind, { restrictOwnAudio: false, controller: env.createCaptureController() }));
    }
    // Windows app. Process loopback that skips Catch Up's own sounds first, then plain loopback.
    const ask = (restrictOwnAudio: boolean) => getDisplayMedia(displayMediaOptions(kind, { restrictOwnAudio }));
    return ask(true).then(
      (stream) => {
        if (liveAudioTrack(stream)) return stream;
        stopStream(stream);
        return ask(false);
      },
      () => ask(false),
    );
  }

  private ensureContext(env: CaptureEnv): AudioContextLike {
    if (this.ctx && this.ctx.state !== "closed") return this.ctx;
    this.detachContext();
    let native = env.nativeRate;
    let ctx: AudioContextLike;
    if (native) ctx = env.createAudioContext(null);
    else {
      try {
        ctx = env.createAudioContext(LIMITS.sampleRate);
      } catch {
        ctx = env.createAudioContext(null);
        native = true;
      }
    }
    this.attachContext(ctx, native);
    return ctx;
  }

  private attachContext(ctx: AudioContextLike, native: boolean): void {
    this.ctx = ctx;
    this.ctxNative = native || Math.round(ctx.sampleRate) !== LIMITS.sampleRate;
    const onState = () => this.onContextState(ctx);
    ctx.addEventListener("statechange", onState);
    this.ctxCleanup = () => ctx.removeEventListener("statechange", onState);
  }

  private detachContext(): void {
    safe(() => this.ctxCleanup?.());
    this.ctxCleanup = null;
    if (this.node) {
      const node = this.node;
      node.port.onmessage = null;
      safe(() => node.disconnect());
    }
    if (this.nodePull) {
      const pull = this.nodePull;
      safe(() => pull.disconnect());
    }
    this.node = null;
    this.nodeCtx = null;
    this.nodePull = null;
    this.moduleLoad = null;
    this.moduleCtx = null;
    this.ctx = null;
    for (const w of this.clearWaiters) w.done();
    this.clearWaiters = [];
  }

  private async ensureWorklet(env: CaptureEnv, ctx: AudioContextLike): Promise<WorkletNodeLike> {
    if (this.node && this.nodeCtx === ctx) return this.node;
    const worklet = ctx.audioWorklet;
    if (!worklet) throw new CaptureError(env.secureContext ? "unsupported" : "insecure_context", "AudioWorklet is missing");
    if (!this.moduleLoad || this.moduleCtx !== ctx) {
      this.moduleCtx = ctx;
      this.moduleLoad = worklet.addModule(this.workletUrl);
    }
    const load = this.moduleLoad;
    try {
      await load;
    } catch {
      if (this.moduleLoad === load) {
        this.moduleLoad = null;
        this.moduleCtx = null;
      }
      throw new CaptureError("unsupported", "The audio worklet did not load");
    }
    if (this.node && this.nodeCtx === ctx) return this.node;
    if (this.ctx !== ctx) throw new CaptureError("device_error", "The audio context was replaced");
    let node: WorkletNodeLike;
    try {
      node = env.createWorkletNode(ctx, WORKLET_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers", // stereo tab audio is averaged to mono
        processorOptions: { seconds: this.memorySec },
      });
    } catch {
      throw new CaptureError("unsupported", "The audio worklet could not start");
    }
    node.port.onmessage = (event) => this.onWorkletMessage(node, event.data);
    const pull = ctx.createGain(); // a silent path to the destination keeps the node pulled in every engine
    pull.gain.value = 0;
    node.connect(pull);
    pull.connect(ctx.destination);
    this.node = node;
    this.nodeCtx = ctx;
    this.nodePull = pull;
    return node;
  }

  private async finishStart(
    env: CaptureEnv,
    gen: number,
    spec: CaptureSourceSpec,
    media: Promise<MediaStreamLike> | null,
    bytes: Promise<ArrayBuffer> | null,
  ): Promise<void> {
    let stream: MediaStreamLike | null = null;
    try {
      let ctx = this.ctx;
      if (!ctx) throw new CaptureError("unsupported");
      let node = await this.ensureWorklet(env, ctx);
      if (gen !== this.gen) {
        void media?.then(stopStream, noop);
        return;
      }
      const session: Session = {
        gen,
        startedAt: Date.now(),
        stream: null,
        nodes: [],
        cleanups: [],
        sample: null,
        endedAt: null,
        hold: null,
        wakeLock: null,
      };
      this.session = session;

      if (spec.kind === "sample") {
        let buffer: AudioBufferLike;
        try {
          buffer = await ctx.decodeAudioData(await bytes!);
        } catch {
          throw new CaptureError("sample_failed", "The sample could not be played");
        }
        if (gen !== this.gen) return;
        this.beginRing(node);
        this.playSample(session, ctx, node, spec, buffer);
      } else {
        try {
          stream = await media!;
        } catch (error) {
          throw new CaptureError(captureErrorCode(error, spec.kind, env.secureContext));
        }
        if (gen !== this.gen) {
          stopStream(stream);
          return;
        }
        session.stream = stream;
        if (!liveAudioTrack(stream)) {
          throw new CaptureError(spec.kind === "mic" ? "device_error" : "no_audio_in_share", "No live audio track");
        }
        let input: AudioNodeLike;
        try {
          input = ctx.createMediaStreamSource(stream);
        } catch (error) {
          if (errorName(error) !== "NotSupportedError" || this.ctxNative) throw new CaptureError("device_error");
          // Firefox before 148 refuses a 16 kHz context fed by a device-rate track. Rebuild at the device rate.
          ({ ctx, node } = await this.rebuildNative(env));
          if (gen !== this.gen) return;
          input = ctx.createMediaStreamSource(stream);
        }
        session.nodes.push(input);
        this.beginRing(node);
        input.connect(node);
        this.watchTracks(session, stream);
      }

      this.watchPage(env, session);
      const now = Date.now();
      session.startedAt = now;
      this.meter.reset(now);
      this.setStatus({ state: "listening", source: spec.kind, startedAt: now });
    } catch (error) {
      if (stream) stopStream(stream);
      if (gen !== this.gen) return; // replaced or paused meanwhile, nothing to report
      const code: CaptureErrorCode = captureErrorCode(error, spec.kind, env.secureContext);
      this.teardown();
      this.setStatus({ state: "error", source: spec.kind, code });
      throw error instanceof CaptureError ? error : new CaptureError(code);
    }
  }

  private async rebuildNative(env: CaptureEnv): Promise<{ ctx: AudioContextLike; node: WorkletNodeLike }> {
    const old = this.ctx;
    this.detachContext();
    if (old) void old.close().catch(noop);
    const ctx = env.createAudioContext(null);
    this.attachContext(ctx, true);
    void ctx.resume().catch(noop);
    const node = await this.ensureWorklet(env, ctx);
    return { ctx, node };
  }

  private failNow(spec: CaptureSourceSpec, code: CaptureErrorCode): Promise<never> {
    this.teardown();
    this.setStatus({ state: "error", source: spec.kind, code });
    return Promise.reject(new CaptureError(code));
  }

  // Sources

  private beginRing(node: WorkletNodeLike): void {
    this.epoch++;
    node.port.postMessage({ type: "clear", epoch: this.epoch });
    node.port.postMessage({ type: "feed", on: true });
    this.memSec = 0;
  }

  private watchTracks(session: Session, stream: MediaStreamLike): void {
    const tracks = stream.getAudioTracks();
    const gen = session.gen;
    const onEnded = () => {
      if (gen !== this.gen) return;
      if (this.status.state !== "listening" && this.status.state !== "starting") return;
      this.emit({ type: "track_ended" });
      this.pauseInternal("source_lost");
    };
    const onMute = () => this.markGap(gen); // memory restarts after a mute or an unmute
    for (const t of tracks) {
      t.addEventListener("ended", onEnded);
      t.addEventListener("mute", onMute);
      t.addEventListener("unmute", onMute);
    }
    session.cleanups.push(() => {
      for (const t of tracks) {
        t.removeEventListener("ended", onEnded);
        t.removeEventListener("mute", onMute);
        t.removeEventListener("unmute", onMute);
      }
    });
  }

  /** Phones keep the screen on and pause (interrupted) when the page hides. */
  private watchPage(env: CaptureEnv, session: Session): void {
    if (!env.phone) return;
    const gen = session.gen;
    const visibility = env.visibility;
    if (visibility) {
      const onVisibility = () => {
        if (visibility.visibilityState !== "hidden" || gen !== this.gen) return;
        if (this.status.state !== "listening" && this.status.state !== "starting") return;
        this.emit({ type: "interrupted" });
        this.pauseInternal("interrupted");
      };
      visibility.addEventListener("visibilitychange", onVisibility);
      session.cleanups.push(() => visibility.removeEventListener("visibilitychange", onVisibility));
    }
    const request = env.requestWakeLock;
    if (request) {
      Promise.resolve()
        .then(request)
        .then(
          (lock) => {
            if (gen === this.gen && this.session === session) session.wakeLock = lock;
            else void lock.release().catch(noop);
          },
          noop, // hidden page, low battery or policy
        );
    }
  }

  private playSample(session: Session, ctx: AudioContextLike, node: WorkletNodeLike, spec: SampleSpec, buffer: AudioBufferLike): void {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.Q.value = Math.SQRT1_2;
    const speaker = ctx.createGain();
    source.connect(node); // clean into the ring
    source.connect(lowpass); // muffled to the speakers only
    lowpass.connect(speaker);
    speaker.connect(ctx.destination);
    session.nodes.push(source, lowpass, speaker);

    const duration = buffer.duration;
    const t0 = ctx.currentTime + SAMPLE_START_DELAY_SEC;
    const clearHz = ctx.sampleRate / 2; // a lowpass at Nyquist passes everything
    lowpass.frequency.value = clearHz;
    lowpass.frequency.setValueAtTime(clearHz, t0);
    speaker.gain.setValueAtTime(1, t0);
    const plan = planMuffle(spec.muffle, duration);
    if (plan) {
      const f = lowpass.frequency;
      const g = speaker.gain;
      f.setValueAtTime(clearHz, t0 + plan.startSec);
      f.exponentialRampToValueAtTime(MUFFLE.lowpassHz, t0 + plan.fullSec);
      f.setValueAtTime(MUFFLE.lowpassHz, t0 + plan.releaseSec);
      f.exponentialRampToValueAtTime(clearHz, t0 + plan.endSec);
      g.setValueAtTime(1, t0 + plan.startSec);
      g.linearRampToValueAtTime(MUFFLE.gain, t0 + plan.fullSec);
      g.setValueAtTime(MUFFLE.gain, t0 + plan.releaseSec);
      g.linearRampToValueAtTime(1, t0 + plan.endSec);
    }

    const run: SampleRun = { spec, ctx, source, t0, duration, tick: null };
    session.sample = run;
    const gen = session.gen;
    source.onended = () => this.onSampleEnded(gen);
    source.start(t0);
    this.emitSample(run, "playing");
    run.tick = setInterval(() => {
      if (gen === this.gen && session.endedAt === null) this.emitSample(run, "playing");
    }, SAMPLE_TICK_MS);
  }

  private emitSample(run: SampleRun, phase: "playing" | "ended"): void {
    const raw = phase === "ended" ? run.duration : run.ctx.currentTime - run.t0;
    const current = Math.min(run.duration, Math.max(0, raw));
    const state = sampleStateAt(run.spec, current);
    this.emit({
      type: "sample",
      phase,
      currentSec: Math.round(current * 100) / 100,
      muffled: phase === "playing" && state.muffled,
      keyMomentPassed: state.keyMomentPassed,
    });
  }

  private onSampleEnded(gen: number): void {
    const session = this.session;
    if (gen !== this.gen || !session || session.gen !== gen || !session.sample || session.endedAt !== null) return;
    const endedAt = Date.now();
    session.endedAt = endedAt;
    const run = session.sample;
    if (run.tick !== null) clearInterval(run.tick);
    run.tick = null;
    // The ring keeps the clip but stops filling, and level readings stop.
    this.node?.port.postMessage({ type: "feed", on: false });
    for (const n of session.nodes.splice(0)) safe(() => n.disconnect());
    this.emitSample(run, "ended");
    this.setStatus({ state: "listening", source: "sample", startedAt: session.startedAt, endedAt });
    session.hold = setTimeout(() => {
      if (gen === this.gen && this.session === session) this.pauseInternal("sample_ended");
    }, LIMITS.snapshotHoldMs);
  }

  // Memory

  private markGap(gen: number): void {
    if (gen !== this.gen || this.status.state !== "listening" || !this.node) return;
    if (this.session?.endedAt !== null) return;
    this.node.port.postMessage({ type: "gap" });
    this.memSec = 0;
    this.emit({ type: "gap" });
  }

  private onContextState(ctx: AudioContextLike): void {
    if (ctx !== this.ctx || ctx.state === "running" || this.status.state !== "listening" || !this.session) return;
    // Interrupted or suspended. Nothing is written until it runs again, so one gap here is enough.
    this.markGap(this.session.gen);
  }

  private pauseInternal(reason: PauseReason, suspend = true): void {
    const prev = this.status;
    const source = prev.state === "idle" ? null : prev.source;
    this.gen++;
    this.teardown();
    this.setStatus({ state: "paused", source, reason });
    if (suspend) void this.suspendWhenCleared();
  }

  /** Stops tracks, disconnects nodes, zeroes the ring and every snapshot. Status is left alone. */
  private teardown(): void {
    const session = this.session;
    this.session = null;
    if (session) {
      for (const fn of session.cleanups.splice(0)) safe(fn);
      const run = session.sample;
      if (run) {
        if (run.tick !== null) clearInterval(run.tick);
        run.tick = null;
        run.source.onended = null;
        safe(() => run.source.stop());
      }
      for (const n of session.nodes.splice(0)) safe(() => n.disconnect());
      if (session.stream) stopStream(session.stream);
      if (session.hold !== null) clearTimeout(session.hold);
      session.hold = null;
      if (session.wakeLock) void session.wakeLock.release().catch(noop);
      session.wakeLock = null;
    }
    this.zeroMemory();
  }

  private zeroMemory(): void {
    if (this.node) {
      this.epoch++;
      this.node.port.postMessage({ type: "clear", epoch: this.epoch });
    }
    for (const snapshot of [...this.snapshots]) snapshot.release();
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Capture was paused"));
    }
    this.waiters.clear();
    this.memSec = 0;
  }

  private clearAcked(): Promise<void> {
    if (!this.node) return Promise.resolve();
    const epoch = this.epoch;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, CLEAR_ACK_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.clearWaiters.push({ epoch, done });
    });
  }

  /** Suspends the context once the worklet confirmed the clear, unless a new start() came first. */
  private async suspendWhenCleared(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const gen = this.gen;
    await this.clearAcked();
    if (this.ctx !== ctx || this.gen !== gen || this.status.state !== "paused" || ctx.state !== "running") return;
    await ctx.suspend().catch(noop);
  }

  private onWorkletMessage(node: WorkletNodeLike, data: unknown): void {
    if (node !== this.node) {
      if (isSnapshotMessage(data)) data.pcm.fill(0);
      return;
    }
    const msg = data as WorkletMessage;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "level") {
      const session = this.session;
      if (msg.epoch !== this.epoch || this.status.state !== "listening" || !session || session.endedAt !== null) return;
      const reading = this.meter.reading(msg, Date.now());
      this.memSec = reading.memorySec;
      for (const listener of [...this.levelListeners]) safe(() => listener(reading));
    } else if (msg.type === "snapshot") {
      if (!isSnapshotMessage(msg)) return;
      const waiter = this.waiters.get(msg.id);
      if (!waiter) {
        msg.pcm.fill(0); // nobody wants it any more, for example after a pause
        return;
      }
      this.waiters.delete(msg.id);
      clearTimeout(waiter.timer);
      if (waiter.gen !== this.gen || msg.epoch !== waiter.epoch) {
        msg.pcm.fill(0);
        waiter.reject(new Error("Capture was paused"));
        return;
      }
      const snapshot = new HeldSnapshot({
        pcm: msg.pcm,
        sampleRate: msg.sampleRate,
        gapCut: msg.gapCut,
        source: waiter.source,
        onRelease: (s) => this.snapshots.delete(s),
      });
      this.snapshots.add(snapshot);
      waiter.resolve(snapshot);
    } else if (msg.type === "cleared") {
      const ready = this.clearWaiters.filter((w) => w.epoch <= msg.epoch);
      this.clearWaiters = this.clearWaiters.filter((w) => w.epoch > msg.epoch);
      for (const w of ready) w.done();
    }
  }

  // Listeners

  private setStatus(next: CaptureStatus): void {
    this.status = next;
    for (const listener of [...this.statusListeners]) safe(listener);
  }

  private emit(event: CaptureEvent): void {
    for (const listener of [...this.eventListeners]) safe(() => listener(event));
  }
}
