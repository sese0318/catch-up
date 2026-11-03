import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS, checkClipWav } from "../protocol";
import { CaptureEngineCore, WORKLET_PROCESSOR } from "./capture";
import type {
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  CaptureEnv,
  MediaStreamLike,
  MediaStreamTrackLike,
  MessagePortLike,
  WakeLockLike,
  WorkletNodeLike,
  WorkletNodeOptions,
} from "./env";
import { MUFFLE } from "./sample";
import type { CaptureEvent, CaptureStatus, LevelReading } from "./types";
import { CaptureError, WORKLET_URL } from "./types";
import { feed, loadRingProcessor, voice, type RingProcessor } from "./worklet-harness";

// Fakes

const rings = new Map<number, ReturnType<typeof loadRingProcessor>>();
function ringFor(rate: number) {
  let ring = rings.get(rate);
  if (!ring) rings.set(rate, (ring = loadRingProcessor(rate)));
  return ring;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

class FakeParam implements AudioParamLike {
  calls: Array<[string, number, number]> = [];
  constructor(public value: number) {}
  setValueAtTime(value: number, time: number) {
    this.calls.push(["set", value, time]);
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.calls.push(["linear", value, time]);
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.calls.push(["exp", value, time]);
  }
}

class FakeNode implements AudioNodeLike {
  connections: AudioNodeLike[] = [];
  disconnected = false;
  constructor(public kind: string) {}
  connect(destination: AudioNodeLike) {
    this.connections.push(destination);
    return destination;
  }
  disconnect() {
    this.connections = [];
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
  constructor() {
    super("gain");
  }
}

class FakeBiquad extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  constructor() {
    super("biquad");
  }
}

class FakeBufferSource extends FakeNode {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  constructor() {
    super("bufferSource");
  }
  start(when?: number) {
    this.startedAt = when ?? 0;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeContext implements AudioContextLike {
  state = "suspended";
  readonly destination = new FakeNode("destination");
  readonly created: FakeNode[] = [];
  readonly audioWorklet = { addModule: vi.fn(async (url: string) => void url) };
  readonly resume = vi.fn(async () => this.setState("running"));
  readonly suspend = vi.fn(async () => this.setState("suspended"));
  readonly close = vi.fn(async () => this.setState("closed"));
  readonly decodeAudioData = vi.fn(async (data: ArrayBuffer) => {
    void data;
    return { duration: this.clipSeconds };
  });
  clipSeconds = 6;
  refuseStreams = false;
  private readonly origin = Date.now();
  private readonly listeners = new Set<() => void>();
  constructor(readonly sampleRate: number) {}
  get currentTime() {
    return (Date.now() - this.origin) / 1000;
  }
  createGain() {
    return this.track(new FakeGain());
  }
  createBiquadFilter() {
    return this.track(new FakeBiquad());
  }
  createBufferSource() {
    return this.track(new FakeBufferSource());
  }
  createMediaStreamSource(stream: MediaStreamLike) {
    void stream;
    if (this.refuseStreams) throw Object.assign(new Error("rates differ"), { name: "NotSupportedError" });
    return this.track(new FakeNode("stream"));
  }
  setState(state: string) {
    if (this.state === state) return;
    this.state = state;
    for (const l of this.listeners) l();
  }
  addEventListener(type: "statechange", listener: () => void) {
    void type;
    this.listeners.add(listener);
  }
  removeEventListener(type: "statechange", listener: () => void) {
    void type;
    this.listeners.delete(listener);
  }
  private track<T extends FakeNode>(node: T): T {
    this.created.push(node);
    return node;
  }
}

class FakeWorkletNode extends FakeNode implements WorkletNodeLike {
  readonly port: MessagePortLike;
  readonly processor: RingProcessor;
  constructor(rate: number, readonly options: WorkletNodeOptions) {
    super("worklet");
    const { processor, setDeliver } = ringFor(rate).create(options.processorOptions.seconds);
    this.processor = processor;
    const port: MessagePortLike = {
      onmessage: null,
      postMessage: (message) => queueMicrotask(() => processor.port.onmessage?.({ data: message })),
    };
    setDeliver((data) => queueMicrotask(() => port.onmessage?.({ data })));
    this.port = port;
  }
}

class FakeTrack implements MediaStreamTrackLike {
  readyState = "live";
  enabled = true;
  stopped = false;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(readonly kind: string) {}
  stop() {
    this.readyState = "ended";
    this.stopped = true;
  }
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    if (type === "ended") this.readyState = "ended";
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
}

class FakeStream implements MediaStreamLike {
  constructor(
    readonly audio: FakeTrack[],
    readonly video: FakeTrack[] = [],
  ) {}
  getAudioTracks() {
    return this.audio;
  }
  getVideoTracks() {
    return this.video;
  }
}

function domError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function setup(patch: Partial<CaptureEnv> = {}) {
  const contexts: FakeContext[] = [];
  const nodes: FakeWorkletNode[] = [];
  const streams: FakeStream[] = [];
  const mic = () => {
    const s = new FakeStream([new FakeTrack("audio")]);
    streams.push(s);
    return s;
  };
  const share = () => {
    const s = new FakeStream([new FakeTrack("audio")], [new FakeTrack("video")]);
    streams.push(s);
    return s;
  };
  const env: CaptureEnv = {
    secureContext: true,
    phone: false,
    nativeRate: false,
    desktopApp: false,
    createAudioContext: (rate) => {
      const ctx = new FakeContext(rate ?? 48_000);
      contexts.push(ctx);
      return ctx;
    },
    createWorkletNode: (ctx, name, options) => {
      expect(name).toBe(WORKLET_PROCESSOR);
      const node = new FakeWorkletNode(ctx.sampleRate, options);
      nodes.push(node);
      return node;
    },
    getUserMedia: vi.fn(async () => mic()),
    getDisplayMedia: vi.fn(async () => share()),
    createCaptureController: () => ({ focus: "no-focus-change" }),
    fetchBytes: vi.fn(async () => new ArrayBuffer(16)),
    requestWakeLock: null,
    visibility: null,
    ...patch,
  };
  const engine = new CaptureEngineCore(() => env);
  const statuses: CaptureStatus[] = [];
  const events: CaptureEvent[] = [];
  const readings: LevelReading[] = [];
  engine.subscribe(() => statuses.push(engine.getStatus()));
  engine.onEvent((e) => events.push(e));
  engine.onLevel((r) => readings.push(r));
  return { env, engine, contexts, nodes, streams, statuses, events, readings };
}

function isZeroed(processor: RingProcessor): boolean {
  return processor.filled === 0 && processor.sinceGap === 0 && processor.buf.every((v) => v === 0);
}

afterEach(() => {
  vi.useRealTimers();
});

// Tests

describe("capture engine, mic", () => {
  it("asks for the mic and resumes the context before any await, with processing off", async () => {
    const { env, engine, contexts } = setup();
    const started = engine.start({ kind: "mic" });
    expect(env.getUserMedia).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].sampleRate).toBe(16_000);
    expect(contexts[0].resume).toHaveBeenCalledTimes(1);
    expect(engine.getStatus()).toEqual({ state: "starting", source: "mic" });
    const constraints = vi.mocked(env.getUserMedia!).mock.calls[0][0];
    expect(constraints).toEqual({
      audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    await started;
    expect(engine.getStatus()).toMatchObject({ state: "listening", source: "mic" });
    expect(contexts[0].audioWorklet.addModule).toHaveBeenCalledWith(WORKLET_URL);
  });

  it("turns noise suppression on only for a noisy room and pins the device", async () => {
    const { env, engine } = setup();
    await engine.start({ kind: "mic", noisyRoom: true, deviceId: "usb-1" });
    expect(vi.mocked(env.getUserMedia!).mock.calls[0][0].audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
      deviceId: { exact: "usb-1" },
    });
  });

  it("fills the ring, reports levels and snapshots a valid clip", async () => {
    const { engine, nodes, readings } = setup();
    await engine.start({ kind: "mic" });
    const node = nodes[0];
    expect(node.options).toMatchObject({ channelCount: 1, channelCountMode: "explicit", processorOptions: { seconds: 120 } });
    feed(node.processor, voice(8, 16_000));
    await flush();
    expect(readings.length).toBeGreaterThan(50);
    expect(readings[readings.length - 1].speech).toBe(true);
    expect(engine.memorySeconds()).toBeGreaterThan(7.8);
    const snap = await engine.snapshot();
    expect(snap.source).toBe("mic");
    expect(snap.memorySec).toBeCloseTo(8, 1);
    const slice = await snap.slice(30);
    expect(slice.sentSec).toBeCloseTo(8, 1);
    expect(slice.silent).toBe(false);
    expect(checkClipWav(slice.wav).ok).toBe(true);
  });

  it("maps a blocked mic and refuses an insecure page without prompting", async () => {
    const blocked = setup({ getUserMedia: vi.fn(async () => Promise.reject(domError("NotAllowedError"))) });
    await expect(blocked.engine.start({ kind: "mic" })).rejects.toMatchObject({ code: "permission_denied" });
    expect(blocked.engine.getStatus()).toEqual({ state: "error", source: "mic", code: "permission_denied" });

    const insecure = setup({ secureContext: false });
    const failed = insecure.engine.start({ kind: "mic" });
    await expect(failed).rejects.toBeInstanceOf(CaptureError);
    await expect(failed).rejects.toMatchObject({ code: "insecure_context" });
    expect(insecure.env.getUserMedia).not.toHaveBeenCalled();
  });

  it.each(["mic", "tab"] as const)("stops %s tracks when the worklet node fails to start", async (kind) => {
    const { engine, streams } = setup({
      createWorkletNode: () => {
        throw new Error("worklet unavailable");
      },
    });
    await expect(engine.start({ kind })).rejects.toMatchObject({ code: "unsupported" });
    await flush();
    expect(streams).toHaveLength(1);
    expect([...streams[0].audio, ...streams[0].video].every((track) => track.stopped)).toBe(true);
    expect(engine.getStatus()).toEqual({ state: "error", source: kind, code: "unsupported" });
  });

  it("stops a share accepted after the worklet module failed", async () => {
    let grant!: (stream: MediaStreamLike) => void;
    const stream = new FakeStream([new FakeTrack("audio")], [new FakeTrack("video")]);
    const { engine } = setup({
      getDisplayMedia: () => new Promise((resolve) => { grant = resolve; }),
      createAudioContext: (rate) => {
        const ctx = new FakeContext(rate ?? 48_000);
        ctx.audioWorklet.addModule.mockRejectedValue(new Error("module unavailable"));
        return ctx;
      },
    });
    await expect(engine.start({ kind: "tab" })).rejects.toMatchObject({ code: "unsupported" });
    grant(stream);
    await flush();
    expect([...stream.audio, ...stream.video].every((track) => track.stopped)).toBe(true);
    expect(engine.getStatus()).toEqual({ state: "error", source: "tab", code: "unsupported" });
  });

  it("stops a late mic grant when a pending worklet fails after pause", async () => {
    let grant!: (stream: MediaStreamLike) => void;
    let rejectModule!: (error: Error) => void;
    const stream = new FakeStream([new FakeTrack("audio")]);
    const { engine } = setup({
      getUserMedia: () => new Promise((resolve) => { grant = resolve; }),
      createAudioContext: (rate) => {
        const ctx = new FakeContext(rate ?? 48_000);
        ctx.audioWorklet.addModule.mockImplementation(() => new Promise((_, reject) => { rejectModule = reject; }));
        return ctx;
      },
    });
    const started = engine.start({ kind: "mic" });
    await engine.pause();
    rejectModule(new Error("module unavailable"));
    await started;
    grant(stream);
    await flush();
    expect(stream.audio[0].stopped).toBe(true);
    expect(engine.getStatus()).toEqual({ state: "paused", source: "mic", reason: "user" });
  });

  it("pause stops a granted mic without waiting for a pending worklet module", async () => {
    let resolveModule!: () => void;
    const { engine, streams } = setup({
      createAudioContext: (rate) => {
        const ctx = new FakeContext(rate ?? 48_000);
        ctx.audioWorklet.addModule.mockImplementation(() => new Promise<undefined>((resolve) => { resolveModule = () => resolve(undefined); }));
        return ctx;
      },
    });
    const started = engine.start({ kind: "mic" });
    await flush();
    expect(streams[0].audio[0].stopped).toBe(false);
    await engine.pause();
    expect(streams[0].audio[0].stopped).toBe(true);
    resolveModule();
    await started;
  });

  it("stops a late share grant after stop while its worklet module is still pending", async () => {
    let grant!: (stream: MediaStreamLike) => void;
    let resolveModule!: () => void;
    const stream = new FakeStream([new FakeTrack("audio")], [new FakeTrack("video")]);
    const { engine } = setup({
      getDisplayMedia: () => new Promise((resolve) => { grant = resolve; }),
      createAudioContext: (rate) => {
        const ctx = new FakeContext(rate ?? 48_000);
        ctx.audioWorklet.addModule.mockImplementation(() => new Promise<undefined>((resolve) => { resolveModule = () => resolve(undefined); }));
        return ctx;
      },
    });
    const started = engine.start({ kind: "tab" });
    await engine.stop();
    grant(stream);
    await flush();
    expect([...stream.audio, ...stream.video].every((track) => track.stopped)).toBe(true);
    resolveModule();
    await started;
  });

  it("a replaced start stops only its own late media grant", async () => {
    let grantOld!: (stream: MediaStreamLike) => void;
    let resolveModule!: () => void;
    const oldStream = new FakeStream([new FakeTrack("audio")]);
    const currentStream = new FakeStream([new FakeTrack("audio")]);
    const { engine } = setup({
      getUserMedia: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { grantOld = resolve; }))
        .mockResolvedValueOnce(currentStream),
      createAudioContext: (rate) => {
        const ctx = new FakeContext(rate ?? 48_000);
        ctx.audioWorklet.addModule.mockImplementation(() => new Promise<undefined>((resolve) => { resolveModule = () => resolve(undefined); }));
        return ctx;
      },
    });
    const oldStart = engine.start({ kind: "mic" });
    const currentStart = engine.start({ kind: "mic" });
    grantOld(oldStream);
    await flush();
    expect(oldStream.audio[0].stopped).toBe(true);
    expect(currentStream.audio[0].stopped).toBe(false);
    resolveModule();
    await Promise.all([oldStart, currentStart]);
    expect(engine.getStatus()).toMatchObject({ state: "listening", source: "mic" });
    expect(currentStream.audio[0].stopped).toBe(false);
    await engine.pause();
  });

  it("marks a gap on mute so a snapshot never glues audio across it", async () => {
    const { engine, nodes, streams, events } = setup();
    await engine.start({ kind: "mic" });
    feed(nodes[0].processor, voice(10, 16_000));
    await flush();
    streams[0].audio[0].fire("mute");
    await flush();
    expect(events).toContainEqual({ type: "gap" });
    feed(nodes[0].processor, voice(2, 16_000));
    await flush();
    const snap = await engine.snapshot();
    expect(snap.gapCut).toBe(true);
    expect(snap.memorySec).toBeCloseTo(2, 1);
    expect(engine.memorySeconds()).toBeLessThan(2.1);
  });

  it("pause stops the tracks, zeroes the ring and every snapshot, and suspends", async () => {
    const { engine, nodes, streams, contexts } = setup();
    await engine.start({ kind: "mic" });
    feed(nodes[0].processor, voice(6, 16_000));
    await flush();
    const snap = await engine.snapshot();
    await engine.pause();
    expect(engine.getStatus()).toEqual({ state: "paused", source: "mic", reason: "user" });
    expect(streams[0].audio[0].stopped).toBe(true);
    expect(snap.released).toBe(true);
    await expect(snap.slice(30)).rejects.toThrow();
    expect(isZeroed(nodes[0].processor)).toBe(true);
    expect(engine.memorySeconds()).toBe(0);
    expect(contexts[0].suspend).toHaveBeenCalled();
    await expect(engine.snapshot()).rejects.toThrow();
  });

  it("resume starts empty in the same context", async () => {
    const { engine, nodes, contexts } = setup();
    await engine.start({ kind: "mic" });
    feed(nodes[0].processor, voice(6, 16_000));
    await flush();
    await engine.pause();
    await engine.start({ kind: "mic" });
    await flush();
    expect(contexts).toHaveLength(1);
    expect(nodes).toHaveLength(1);
    expect(isZeroed(nodes[0].processor)).toBe(true);
    feed(nodes[0].processor, voice(1, 16_000));
    await flush();
    // Levels arrive about every 100 ms, so memory can lag that much behind the ring.
    expect(engine.memorySeconds()).toBeGreaterThan(0.85);
    expect(engine.memorySeconds()).toBeLessThanOrEqual(1);
  });

  it("stop closes the context and the next start builds a new one", async () => {
    const { engine, contexts } = setup();
    await engine.start({ kind: "mic" });
    await engine.stop();
    expect(engine.getStatus()).toEqual({ state: "paused", source: "mic", reason: "user" });
    expect(contexts[0].close).toHaveBeenCalled();
    await engine.start({ kind: "mic" });
    expect(contexts).toHaveLength(2);
  });

  it("rebuilds at the device rate when a 16 kHz context refuses the track", async () => {
    const { engine, contexts, nodes } = setup({
      createAudioContext: (rate) => {
        const ctx = new FakeContext(rate ?? 48_000);
        ctx.refuseStreams = rate === 16_000;
        contexts.push(ctx);
        return ctx;
      },
    });
    await engine.start({ kind: "mic" });
    expect(contexts.map((c) => c.sampleRate)).toEqual([16_000, 48_000]);
    expect(contexts[0].close).toHaveBeenCalled();
    expect(engine.getStatus().state).toBe("listening");
    const node = nodes[nodes.length - 1];
    feed(node.processor, voice(6, 48_000));
    await flush();
    const slice = await (await engine.snapshot()).slice(30);
    const check = checkClipWav(slice.wav);
    expect(check.ok && check.wav.sampleRate).toBe(16_000);
    expect(slice.sentSec).toBeCloseTo(6, 1);
  });

  it("runs WebKit at the device rate and still sends 16 kHz", async () => {
    const { engine, contexts, nodes } = setup({ nativeRate: true });
    await engine.start({ kind: "mic" });
    expect(contexts[0].sampleRate).toBe(48_000);
    feed(nodes[0].processor, voice(7, 48_000));
    await flush();
    expect(engine.memorySeconds()).toBeGreaterThan(6.8);
    const slice = await (await engine.snapshot()).slice(30);
    expect(checkClipWav(slice.wav).ok).toBe(true);
  });
});

describe("capture engine, tab and system audio", () => {
  it("keeps the display video live at 1 fps and never sends restrictOwnAudio from a browser", async () => {
    const { env, engine, streams } = setup();
    const started = engine.start({ kind: "tab" });
    expect(env.getDisplayMedia).toHaveBeenCalledTimes(1);
    const options = vi.mocked(env.getDisplayMedia!).mock.calls[0][0] as Record<string, Record<string, unknown>>;
    expect(options.video).toMatchObject({ displaySurface: "browser", frameRate: { max: 1 } });
    expect(options.audio).toMatchObject({ suppressLocalAudioPlayback: false, echoCancellation: false, autoGainControl: false });
    expect(options.audio).not.toHaveProperty("restrictOwnAudio");
    expect(options).toMatchObject({ selfBrowserSurface: "exclude", systemAudio: "include", windowAudio: "system" });
    expect(options.controller).toEqual({ focus: "no-focus-change" });
    await started;
    const video = streams[0].video[0];
    expect(video.stopped).toBe(false);
    expect(video.enabled).toBe(true);
  });

  it("raises no_audio_in_share for a share without audio and stops its tracks", async () => {
    const video = new FakeTrack("video");
    const { engine } = setup({ getDisplayMedia: vi.fn(async () => new FakeStream([], [video])) });
    await expect(engine.start({ kind: "system" })).rejects.toMatchObject({ code: "no_audio_in_share" });
    expect(engine.getStatus()).toEqual({ state: "error", source: "system", code: "no_audio_in_share" });
    expect(video.stopped).toBe(true);
  });

  it("maps a closed picker to share_cancelled", async () => {
    const { engine } = setup({ getDisplayMedia: vi.fn(async () => Promise.reject(domError("NotAllowedError"))) });
    await expect(engine.start({ kind: "tab" })).rejects.toMatchObject({ code: "share_cancelled" });
  });

  it("refuses tab audio where getDisplayMedia does not exist", async () => {
    const { engine } = setup({ getDisplayMedia: null });
    await expect(engine.start({ kind: "tab" })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("pauses with source_lost when sharing stops, and zeroes memory", async () => {
    const { engine, nodes, streams, events } = setup();
    await engine.start({ kind: "tab" });
    feed(nodes[0].processor, voice(6, 16_000));
    await flush();
    const snap = await engine.snapshot();
    streams[0].audio[0].fire("ended");
    expect(events).toContainEqual({ type: "track_ended" });
    expect(engine.getStatus()).toEqual({ state: "paused", source: "tab", reason: "source_lost" });
    expect(snap.released).toBe(true);
    expect(streams[0].video[0].stopped).toBe(true);
    await flush();
    expect(isZeroed(nodes[0].processor)).toBe(true);
  });

  it("uses restrictOwnAudio only in the Windows app, and retries without it", async () => {
    let calls = 0;
    const getDisplayMedia = vi.fn(async () => {
      calls++;
      if (calls === 1) throw domError("NotReadableError");
      return new FakeStream([new FakeTrack("audio")], [new FakeTrack("video")]);
    });
    const { engine } = setup({ desktopApp: true, getDisplayMedia });
    await engine.start({ kind: "system" });
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
    const first = getDisplayMedia.mock.calls[0] as unknown as [Record<string, Record<string, unknown>>];
    const second = getDisplayMedia.mock.calls[1] as unknown as [Record<string, Record<string, unknown>>];
    expect(first[0].audio.restrictOwnAudio).toBe(true);
    expect(second[0].audio).not.toHaveProperty("restrictOwnAudio");
    expect(first[0].video).toMatchObject({ displaySurface: "monitor", frameRate: { max: 1 } });
    expect(engine.getStatus().state).toBe("listening");
  });
});

describe("capture engine, samples", () => {
  const sample = {
    kind: "sample" as const,
    clipId: "ask-by-name",
    url: "/samples/ask-by-name.wav",
    muffle: { startSec: 2, endSec: 4 },
    keyMomentSec: 3,
  };

  it("plays clean into the ring and muffled to the speakers only", async () => {
    const { env, engine, contexts, nodes } = setup();
    await engine.start(sample);
    expect(env.fetchBytes).toHaveBeenCalledWith(sample.url);
    const ctx = contexts[0];
    const source = ctx.created.find((n) => n.kind === "bufferSource") as FakeBufferSource;
    const lowpass = ctx.created.find((n) => n.kind === "biquad") as FakeBiquad;
    expect(source.startedAt).not.toBeNull();
    expect(source.connections).toContain(nodes[0]);
    expect(source.connections).toContain(lowpass);
    const speaker = lowpass.connections[0] as FakeGain;
    expect(speaker.connections).toContain(ctx.destination);
    expect(lowpass.frequency.calls).toContainEqual(["exp", MUFFLE.lowpassHz, expect.any(Number)]);
    expect(speaker.gain.calls).toContainEqual(["linear", MUFFLE.gain, expect.any(Number)]);
  });

  it("reports progress, the muffled zone and the key moment", async () => {
    vi.useFakeTimers();
    const { engine, events } = setup();
    await engine.start(sample);
    expect(events[0]).toMatchObject({ type: "sample", phase: "playing", muffled: false, keyMomentPassed: false });
    vi.advanceTimersByTime(3_300);
    const latest = events.filter((e) => e.type === "sample").pop();
    expect(latest).toMatchObject({ phase: "playing", muffled: true, keyMomentPassed: true });
  });

  it("stays pressable after the clip ends, then pauses with sample_ended after the hold", async () => {
    vi.useFakeTimers();
    const { engine, contexts, nodes, events, readings, statuses } = setup();
    await engine.start(sample);
    const processor = nodes[0].processor;
    feed(processor, voice(6, 16_000));
    await flush();
    const source = contexts[0].created.find((n) => n.kind === "bufferSource") as FakeBufferSource;
    source.onended!();
    await flush();

    const status = engine.getStatus();
    expect(status).toMatchObject({ state: "listening", source: "sample", endedAt: expect.any(Number) });
    expect(events).toContainEqual(expect.objectContaining({ type: "sample", phase: "ended", muffled: false }));
    expect(engine.memorySeconds()).toBeGreaterThan(5.5);

    // The ring stops filling and level readings stop.
    const filled = processor.filled;
    const heard = readings.length;
    feed(processor, voice(1, 16_000));
    await flush();
    expect(processor.filled).toBe(filled);
    expect(readings.length).toBe(heard);

    const snap = await engine.snapshot();
    const slice = await snap.slice(30);
    expect(slice.sentSec).toBeCloseTo(6, 1);
    expect(checkClipWav(slice.wav).ok).toBe(true);

    vi.advanceTimersByTime(LIMITS.snapshotHoldMs - 1_000);
    expect(engine.getStatus()).toBe(status);
    vi.advanceTimersByTime(1_000);
    expect(engine.getStatus()).toEqual({ state: "paused", source: "sample", reason: "sample_ended" });
    expect(statuses[statuses.length - 1]).toEqual(engine.getStatus());
    expect(snap.released).toBe(true);
    await flush();
    expect(isZeroed(processor)).toBe(true);
  });

  it("a new start replaces a playing sample and wipes memory", async () => {
    const { engine, contexts, nodes, statuses } = setup();
    await engine.start(sample);
    feed(nodes[0].processor, voice(3, 16_000));
    await flush();
    const source = contexts[0].created.find((n) => n.kind === "bufferSource") as FakeBufferSource;
    await engine.start({ kind: "mic" });
    expect(statuses.map((s) => s.state)).toContain("paused");
    expect(statuses.find((s) => s.state === "paused")).toEqual({ state: "paused", source: "sample", reason: "replaced" });
    expect(source.stopped).toBe(true);
    expect(source.onended).toBeNull();
    await flush();
    expect(isZeroed(nodes[0].processor)).toBe(true);
    expect(engine.getStatus()).toMatchObject({ state: "listening", source: "mic" });
  });

  it("reports sample_failed when the clip cannot be decoded", async () => {
    const { engine } = setup({ fetchBytes: vi.fn(async () => Promise.reject(new Error("404"))) });
    await expect(engine.start(sample)).rejects.toMatchObject({ code: "sample_failed" });
    expect(engine.getStatus()).toEqual({ state: "error", source: "sample", code: "sample_failed" });
  });
});

describe("capture engine, phones", () => {
  it("holds a wake lock and pauses with interrupted when the page hides", async () => {
    const listeners = new Set<() => void>();
    const visibility = {
      visibilityState: "visible",
      addEventListener: (_: "visibilitychange", l: () => void) => listeners.add(l),
      removeEventListener: (_: "visibilitychange", l: () => void) => listeners.delete(l),
    };
    const lock: WakeLockLike = { release: vi.fn(async () => undefined) };
    const { engine, nodes, events, streams } = setup({
      phone: true,
      visibility,
      requestWakeLock: vi.fn(async () => lock),
    });
    await engine.start({ kind: "mic" });
    await flush();
    feed(nodes[0].processor, voice(6, 16_000));
    await flush();
    visibility.visibilityState = "hidden";
    for (const l of [...listeners]) l();
    expect(events).toContainEqual({ type: "interrupted" });
    expect(engine.getStatus()).toEqual({ state: "paused", source: "mic", reason: "interrupted" });
    expect(lock.release).toHaveBeenCalled();
    expect(streams[0].audio[0].stopped).toBe(true);
    expect(listeners.size).toBe(0);
    await flush();
    expect(isZeroed(nodes[0].processor)).toBe(true);
  });
});
