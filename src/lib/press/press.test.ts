import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowSec } from "@/lib/card/schema";
import { Card } from "@/lib/card/schema";
import {
  LIMITS,
  SSE_HEADERS,
  TRANSCRIPT_CONTENT_TYPE,
  checkClipWav,
  decodeMetaHeader,
  encodeEventBytes,
  errorEventResponse,
  toLocalIso,
  type StreamEvent,
  type WireCard,
} from "@/lib/protocol";
import { getCachedCard, getSampleClip, type SampleClip } from "@/lib/samples/catalog";
import { buildClipSlice } from "@/lib/audio/clip";
import type {
  CaptureEngine,
  CaptureSourceSpec,
  CaptureStatus,
  ClipSlice,
  PressEvent,
  PressSettings,
  Snapshot,
} from "@/lib/audio/types";
import { voice } from "@/lib/audio/worklet-harness";
import { createPressPipeline, newSessionId } from "./press";

// The card lane's strings and the eval lane's catalog are mocked until those lanes land.
vi.mock("@/lib/card/strings", () => ({ stallLine: (lang: string) => `stall-${lang}` }));
vi.mock("@/lib/samples/catalog", () => ({ getCachedCard: vi.fn(() => null), getSampleClip: vi.fn(() => null) }));

// Fakes

class FakeSnapshot implements Snapshot {
  readonly id = "snap_test";
  readonly takenAt = Date.now();
  readonly gapCut = false;
  readonly memorySec: number;
  readonly slices: WindowSec[] = [];
  private pcm: Float32Array | null;
  constructor(
    pcm: Float32Array,
    private readonly rate: number,
    readonly source: CaptureSourceSpec["kind"],
  ) {
    this.pcm = pcm;
    this.memorySec = pcm.length / rate;
  }
  get released() {
    return this.pcm === null;
  }
  async slice(windowSec: WindowSec): Promise<ClipSlice> {
    if (!this.pcm) throw new Error("released");
    this.slices.push(windowSec);
    return buildClipSlice(this.pcm, this.rate, windowSec);
  }
  release() {
    this.pcm?.fill(0);
    this.pcm = null;
  }
}

function fakeEngine(opts: { pcm?: Float32Array; spec?: CaptureSourceSpec; memorySec?: number } = {}) {
  const spec: CaptureSourceSpec = opts.spec ?? { kind: "mic" };
  const pcm = opts.pcm ?? voice(40, 16_000);
  let status: CaptureStatus = { state: "listening", source: spec.kind, startedAt: 0 };
  let memorySec = opts.memorySec ?? 40;
  const listeners = new Set<() => void>();
  const snapshots: FakeSnapshot[] = [];
  const engine: CaptureEngine = {
    getStatus: () => status,
    getSource: () => spec,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onLevel: () => () => undefined,
    onEvent: () => () => undefined,
    start: async () => undefined,
    pause: async () => {
      for (const s of snapshots) s.release();
      status = { state: "paused", source: spec.kind, reason: "user" };
      for (const l of [...listeners]) l();
    },
    stop: async () => undefined,
    memorySeconds: () => memorySec,
    snapshot: vi.fn(async () => {
      const s = new FakeSnapshot(pcm.slice(), 16_000, spec.kind);
      snapshots.push(s);
      return s;
    }),
  };
  return {
    engine,
    snapshots,
    setStatus: (s: CaptureStatus) => (status = s),
    setMemory: (s: number) => (memorySec = s),
  };
}

interface Captured {
  url: string;
  method?: string;
  headers: Headers;
  body: Uint8Array;
  signal?: AbortSignal | null;
}

type Step = StreamEvent | { wait: number };

function sseResponse(steps: Step[], signal?: AbortSignal | null, status = 200): Response {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      ctrl = controller;
      for (const step of steps) {
        if (signal?.aborted) return;
        if ("wait" in step) await new Promise((r) => setTimeout(r, step.wait));
        else controller.enqueue(encodeEventBytes(step));
      }
      if (!signal?.aborted) controller.close();
    },
  });
  signal?.addEventListener("abort", () => {
    try {
      ctrl?.error(new DOMException("aborted", "AbortError"));
    } catch {
      // already closed
    }
  });
  return new Response(body, { status, headers: SSE_HEADERS });
}

function fakeFetch(handler: (req: Captured, call: number) => Response | Promise<Response>) {
  const requests: Captured[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    // fetch copies the body when the request is made, so copy it now
    const raw = init?.body as ArrayBuffer;
    const captured: Captured = {
      url: String(url),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: new Uint8Array(raw.slice(0)),
      signal: init?.signal,
    };
    requests.push(captured);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return handler(captured, requests.length);
  });
  return { fn: fn as unknown as typeof fetch, mock: fn, requests };
}

function pending(req: Captured): Promise<Response> {
  return new Promise((_, reject) => {
    req.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

const wireB: WireCard = {
  heard: "clear",
  ask: { to: "you", text: "Does Thursday work for the demo?", by: "Alex" },
  say: { text: "Just to check, Thursday for the demo?", lang: "en" },
  summary: ["Alex asked if Thursday works for the demo."],
  facts: [{ kind: "date", text: "Thursday" }],
  quote: "So Seika, does Thursday work for the demo?",
  meta: {
    route: "open_weights",
    model: "meta-models/muse-spark-open-1026",
    parse: "clean",
    timing: { totalMs: 2100, firstTokenMs: 900, bytes: 960_044 },
  },
};

const wireA: WireCard = {
  ...wireB,
  meta: {
    route: "meta_api",
    model: "muse-voice-transcribe-1.0 + muse-spark-1.3",
    parse: "clean",
    transcript: "So Seika, does Thursday work for the demo, or should we push to Monday?",
    timing: { totalMs: 3200, asrMs: 900, bytes: 960_044 },
  },
};

const okSteps = (wire: WireCard = wireB): Step[] => [
  { wait: 200 },
  { event: "stage", data: { name: "received" } },
  { wait: 800 },
  { event: "stage", data: { name: "writing" } },
  { wait: 1_500 },
  { event: "card", data: wire },
  { event: "done", data: {} },
];

const settings: PressSettings = {
  cardLang: "en",
  meetingLang: "ja",
  windowSec: 30,
  names: ["  Seika ", "seika", "セイカ"],
  hint: "  Dr. Rivera,   BIO-110 ",
  route: "auto",
  tz: "America/New_York",
};

function setup(opts: Parameters<typeof fakeEngine>[0] & { settings?: Partial<PressSettings>; sessionId?: string } = {}) {
  const fe = fakeEngine(opts);
  let current: PressSettings = { ...settings, ...opts.settings };
  const server: { handler: (req: Captured, call: number) => Response | Promise<Response> } = {
    handler: (req) => sseResponse(okSteps(), req.signal),
  };
  const net = fakeFetch((req, call) => server.handler(req, call));
  const pipeline = createPressPipeline({
    engine: fe.engine,
    getSettings: () => current,
    sessionId: opts.sessionId ?? "sess_0123456789",
    fetchImpl: net.fn,
  });
  const events: PressEvent[] = [];
  pipeline.on((e) => events.push(e));
  return {
    ...fe,
    pipeline,
    events,
    server,
    net,
    setSettings: (patch: Partial<PressSettings>) => (current = { ...current, ...patch }),
  };
}

function ofType<T extends PressEvent["type"]>(events: PressEvent[], type: T): Extract<PressEvent, { type: T }>[] {
  return events.filter((e): e is Extract<PressEvent, { type: T }> => e.type === type);
}

function metaOf(req: Captured) {
  const decoded = decodeMetaHeader(req.headers.get("X-CatchUp-Meta"));
  if (!decoded.ok) throw new Error(decoded.issue);
  return decoded.meta;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getCachedCard).mockReset().mockReturnValue(null);
  vi.mocked(getSampleClip).mockReset().mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Tests

describe("press pipeline", () => {
  it("shows the stall line at 0 ms, then sends the clip and lands a card with the sent record", async () => {
    const { pipeline, events, net, snapshots } = setup();
    const pressedAt = Date.now();
    const result = pipeline.press({ kind: "new", pressedAt });
    expect(result.accepted).toBe(true);
    const pressId = result.accepted ? result.pressId : "";
    expect(events).toEqual([
      { type: "pressed", pressId, kind: "new", pressedAt, startedAt: pressedAt, stall: { text: "stall-ja", lang: "ja" } },
    ]);
    expect(pipeline.isBusy()).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(events.map((e) => e.type)).toEqual(["pressed", "held", "sending", "stage", "stage", "card"]);
    expect(ofType(events, "held")[0]).toEqual({ type: "held", until: snapshots[0].takenAt + LIMITS.snapshotHoldMs, memorySec: 40 });
    expect(ofType(events, "sending")[0]).toEqual({ type: "sending", pressId, windowSec: 30, sentSec: 30, bytes: 960_044, partial: false });
    expect(ofType(events, "stage").map((e) => [e.name, e.elapsedMs])).toEqual([
      ["received", 200],
      ["writing", 1_000],
    ]);

    const { card, replaces, server } = ofType(events, "card")[0];
    expect(Card.safeParse(card).success).toBe(true);
    expect(replaces).toBeNull();
    expect(server).toEqual(wireB.meta.timing);
    expect(card.ask).toEqual(wireB.ask);
    expect(card.meta).toMatchObject({
      pressedAt: toLocalIso(pressedAt),
      windowSec: 30,
      sentSec: 30,
      cardLang: "en",
      source: "mic",
      route: "open_weights",
      model: "meta-models/muse-spark-open-1026",
      bytesSent: 960_044,
      sent: { body: "audio", names: true, hint: true },
      ms: { total: 2_500, firstToken: 1_000, upload: 200 },
    });

    expect(net.requests).toHaveLength(1);
    const req = net.requests[0];
    expect(req.url).toBe("/api/card");
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe("audio/wav");
    expect(checkClipWav(req.body).ok).toBe(true);
    expect(metaOf(req)).toEqual({
      v: 1,
      pressedAt: toLocalIso(pressedAt),
      tz: "America/New_York",
      cardLang: "en",
      meetingLang: "ja",
      windowSec: 30,
      sentSec: 30,
      source: "mic",
      names: ["Seika", "セイカ"],
      hint: "Dr. Rivera, BIO-110",
      route: "auto",
      sessionId: "sess_0123456789",
    });
    expect(pipeline.isBusy()).toBe(false);
    expect(pipeline.heldUntil()).toBe(snapshots[0].takenAt + LIMITS.snapshotHoldMs);
    expect(req.signal?.aborted).toBe(false); // read to done, never cut after the card
  });

  it("cuts a stream that keeps running after its card", async () => {
    const { pipeline, events, server, net } = setup();
    server.handler = (req) => sseResponse([{ event: "card", data: wireB }, { wait: 60_000 }, { event: "done", data: {} }], req.signal);
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(100);
    expect(ofType(events, "card")).toHaveLength(1);
    expect(net.requests[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(net.requests[0].signal?.aborted).toBe(true);
    expect(ofType(events, "error")).toHaveLength(0);
  });

  it("says when memory held less than the window, and sends no names or hint when there are none", async () => {
    const { pipeline, events, net } = setup({ pcm: voice(12, 16_000), memorySec: 12, settings: { names: [" "], hint: "" } });
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ofType(events, "sending")[0]).toMatchObject({ windowSec: 30, sentSec: 12, partial: true });
    expect(ofType(events, "card")[0].card.meta.sent).toEqual({ body: "audio", names: false, hint: false });
    const meta = metaOf(net.requests[0]);
    expect(meta.names).toEqual([]);
    expect(meta).not.toHaveProperty("hint");
  });

  it("passes a server error through with sent true", async () => {
    const { pipeline, events, server } = setup();
    server.handler = () => errorEventResponse("rate_limited", { retryAfterSec: 60 });
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(events, "error")).toEqual([
      { type: "error", pressId: expect.any(String), code: "rate_limited", retryable: true, sent: true, retryAfterSec: 60 },
    ]);
    expect(ofType(events, "card")).toHaveLength(0);
    expect(pipeline.isBusy()).toBe(false);
  });

  it("maps a response that is not an event stream by its status", async () => {
    const { pipeline, events, server } = setup();
    server.handler = () => new Response("Request Entity Too Large", { status: 413, headers: { "content-type": "text/plain" } });
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(events, "error")[0]).toMatchObject({ code: "too_large", sent: true, retryable: false });
  });

  it("reports a fetch failure as network, and a stream that ends early as server_error", async () => {
    const failing = setup();
    failing.server.handler = () => Promise.reject(new TypeError("Failed to fetch"));
    failing.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(failing.events, "error")[0]).toMatchObject({ code: "network", retryable: true });

    const cut = setup();
    cut.server.handler = (req) => sseResponse([{ event: "stage", data: { name: "received" } }], req.signal);
    cut.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(cut.events, "error")[0]).toMatchObject({ code: "server_error", sent: true });
  });

  it("says still working at 6 s and gives up at the 20 s hard cap", async () => {
    const { pipeline, events, server, net } = setup();
    server.handler = (req) => pending(req);
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_900);
    expect(ofType(events, "still_working")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(ofType(events, "still_working")).toEqual([{ type: "still_working", pressId: expect.any(String), elapsedMs: 6_000 }]);
    await vi.advanceTimersByTimeAsync(LIMITS.hardCapMs - 6_100 - 1);
    expect(ofType(events, "error")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ofType(events, "error")).toEqual([
      { type: "error", pressId: expect.any(String), code: "timeout", retryable: true, sent: true },
    ]);
    expect(net.requests[0].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ofType(events, "error")).toHaveLength(1);
  });

  it("Esc emits cancelled and never an error", async () => {
    const { pipeline, events, server, net } = setup();
    server.handler = (req) => pending(req);
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(500);
    pipeline.cancel();
    expect(events[events.length - 1]).toEqual({ type: "cancelled", pressId: expect.any(String), sent: true });
    expect(pipeline.isBusy()).toBe(false);
    expect(net.requests[0].signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ofType(events, "error")).toHaveLength(0);
    expect(ofType(events, "still_working")).toHaveLength(0);
    expect(ofType(events, "cancelled")).toHaveLength(1);
  });

  it("ignores a second press while one is in flight", async () => {
    const { pipeline, events, net } = setup();
    expect(pipeline.press({ kind: "new", pressedAt: Date.now() }).accepted).toBe(true);
    expect(pipeline.press({ kind: "new", pressedAt: Date.now() })).toEqual({ accepted: false, reason: "busy" });
    expect(pipeline.press({ kind: "further_back" })).toEqual({ accepted: false, reason: "busy" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ofType(events, "pressed")).toHaveLength(1);
    expect(net.requests).toHaveLength(1);
  });

  it("turns a header that fails to encode into bad_request with nothing sent", async () => {
    const { pipeline, events, net } = setup({ sessionId: "bad id" });
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(events, "error")).toEqual([
      { type: "error", pressId: expect.any(String), code: "bad_request", retryable: false, sent: false },
    ]);
    expect(ofType(events, "sending")).toHaveLength(0);
    expect(net.requests).toHaveLength(0);
  });

  it("refuses presses it cannot serve", () => {
    const idle = setup();
    idle.setStatus({ state: "paused", source: "mic", reason: "user" });
    expect(idle.pipeline.press({ kind: "new", pressedAt: Date.now() })).toEqual({ accepted: false, reason: "not_listening" });
    const warming = setup({ memorySec: 3 });
    expect(warming.pipeline.press({ kind: "new", pressedAt: Date.now() })).toEqual({ accepted: false, reason: "warming_up" });
    for (const request of [{ kind: "further_back" }, { kind: "send_anyway" }, { kind: "retry" }, { kind: "language", cardLang: "ja" }] as const) {
      expect(warming.pipeline.press(request)).toEqual({ accepted: false, reason: "nothing_held" });
    }
    expect(warming.events).toHaveLength(0);
  });

  it("holds back silence without a request, and Send anyway sends that slice", async () => {
    const { pipeline, events, net, engine } = setup({ pcm: new Float32Array(16_000 * 40) });
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.map((e) => e.type)).toEqual(["pressed", "held", "silent"]);
    expect(ofType(events, "silent")[0]).toEqual({ type: "silent", pressId: expect.any(String), windowSec: 30, sentSec: 30 });
    expect(net.requests).toHaveLength(0);
    expect(pipeline.isBusy()).toBe(false);

    expect(pipeline.press({ kind: "send_anyway" }).accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(net.requests).toHaveLength(1);
    expect(checkClipWav(net.requests[0].body).ok).toBe(true);
    expect(ofType(events, "card")).toHaveLength(1);
    expect(engine.snapshot).toHaveBeenCalledTimes(1);
    expect(pipeline.press({ kind: "send_anyway" })).toEqual({ accepted: false, reason: "nothing_held" });

    // The override holds for this press, so a language chip sends the clip instead of saying no one spoke.
    expect(pipeline.press({ kind: "language", cardLang: "ja" }).accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(net.requests).toHaveLength(2);
    expect(ofType(events, "silent")).toHaveLength(1);
    expect(ofType(events, "card")).toHaveLength(2);
  });

  it("drops a cancelled press's late snapshot when a newer press already took its own", async () => {
    const { pipeline, events, engine } = setup();
    const waiting: Array<(snapshot: Snapshot) => void> = [];
    vi.mocked(engine.snapshot).mockImplementation(() => new Promise<Snapshot>((resolve) => void waiting.push(resolve)));
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(10);
    pipeline.cancel();
    expect(pipeline.press({ kind: "new", pressedAt: Date.now() }).accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(waiting).toHaveLength(2);

    const stale = new FakeSnapshot(voice(40, 16_000), 16_000, "mic");
    const fresh = new FakeSnapshot(voice(40, 16_000), 16_000, "mic");
    waiting[0](stale);
    await vi.advanceTimersByTimeAsync(0);
    expect(stale.released).toBe(true);
    waiting[1](fresh);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fresh.released).toBe(false);
    expect(ofType(events, "card")).toHaveLength(1);
    expect(ofType(events, "held").filter((e) => e.until !== null)).toHaveLength(1);
  });

  it("fails on the device when health says the server would refuse the press unread", async () => {
    const off = setup({ settings: { live: { liveOff: true, defaultRoute: "auto", configured: ["open_weights", "meta_api"] } } });
    off.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(off.events, "error")).toEqual([
      { type: "error", pressId: expect.any(String), code: "live_off", retryable: false, sent: false },
    ]);
    expect(off.net.requests).toHaveLength(0);
    expect(off.pipeline.heldUntil()).not.toBeNull(); // the clip stays for Retry

    const keyless = setup({ settings: { live: { liveOff: false, defaultRoute: "auto", configured: [] } } });
    keyless.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(keyless.events, "error")[0]).toMatchObject({ code: "not_configured", sent: false });
    expect(keyless.net.requests).toHaveLength(0);

    const pinned = setup({ settings: { route: "meta_api", live: { liveOff: false, defaultRoute: "auto", configured: ["open_weights"] } } });
    pinned.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(pinned.events, "error")[0]).toMatchObject({ code: "not_configured", sent: false });

    const ready = setup({ settings: { live: { liveOff: false, defaultRoute: "auto", configured: ["open_weights"] } } });
    ready.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ready.net.requests).toHaveLength(1);
    expect(ofType(ready.events, "card")).toHaveLength(1);

    const mock = setup({ settings: { route: "mock", mock: { mode: "ok" }, live: { liveOff: true, defaultRoute: "auto", configured: [] } } });
    mock.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.net.requests).toHaveLength(1); // mock ignores the kill switch, as the server does
  });

  it("Further back and a Route A language redo reuse the held press", async () => {
    const { pipeline, events, net, server, snapshots, engine } = setup();
    server.handler = (req) => sseResponse(okSteps(wireA), req.signal);
    const pressedAt = Date.now();
    pipeline.press({ kind: "new", pressedAt });
    await vi.advanceTimersByTimeAsync(5_000);
    const first = ofType(events, "card")[0].card;

    expect(pipeline.press({ kind: "further_back" }).accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    const second = ofType(events, "card")[1];
    expect(second.replaces).toBe(first.meta.id);
    expect(second.card.meta.windowSec).toBe(60);
    expect(second.card.meta.pressedAt).toBe(toLocalIso(pressedAt));
    expect(ofType(events, "pressed")[1]).toMatchObject({ kind: "further_back", pressedAt });
    expect(ofType(events, "pressed")[1].startedAt).toBeGreaterThanOrEqual(pressedAt + 5_000); // counts from the redo
    expect(metaOf(net.requests[1])).toMatchObject({ windowSec: 60, sentSec: 40, pressedAt: toLocalIso(pressedAt) });
    expect(snapshots[0].slices).toEqual([30, 60]);
    expect(engine.snapshot).toHaveBeenCalledTimes(1);

    expect(pipeline.press({ kind: "language", cardLang: "ja" }).accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    const third = ofType(events, "card")[2];
    expect(third.replaces).toBe(second.card.meta.id);
    const redo = net.requests[2];
    expect(redo.headers.get("content-type")).toBe(TRANSCRIPT_CONTENT_TYPE);
    expect(new TextDecoder().decode(redo.body)).toBe(wireA.meta.transcript);
    expect(metaOf(redo)).toMatchObject({ route: "meta_api", cardLang: "ja", windowSec: 60, sentSec: 40 });
    expect(third.card.meta.sent).toEqual({ body: "transcript", names: true, hint: true });
    expect(third.card.meta.cardLang).toBe("ja");

    // The 60 s card already holds all 40 s there was, so Further back has nothing older to send.
    expect(pipeline.press({ kind: "further_back" })).toEqual({ accepted: false, reason: "nothing_more" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(snapshots[0].slices).toEqual([30, 60]);
    expect(net.requests).toHaveLength(3);
  });

  it("steps up to 120 s while memory holds more, then stops", async () => {
    const { pipeline, events, snapshots } = setup({ pcm: voice(125, 16_000), memorySec: 120 });
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    for (const windowSec of [60, 120] as const) {
      expect(pipeline.press({ kind: "further_back" }).accepted).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ofType(events, "card").at(-1)?.card.meta.windowSec).toBe(windowSec);
    }
    expect(snapshots[0].slices).toEqual([30, 60, 120]);
    expect(pipeline.press({ kind: "further_back" })).toEqual({ accepted: false, reason: "nothing_more" });
  });

  it("never sends the same clip again as Further back when the card already holds all there was", async () => {
    const partial = setup({ pcm: voice(12, 16_000), memorySec: 12 });
    partial.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ofType(partial.events, "card")[0].card.meta.sentSec).toBe(12);
    expect(partial.pipeline.press({ kind: "further_back" })).toEqual({ accepted: false, reason: "nothing_more" });
    expect(partial.net.requests).toHaveLength(1);

    const barely = setup({ pcm: voice(30.3, 16_000), memorySec: 30.3 });
    barely.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ofType(barely.events, "card")[0].card.meta.sentSec).toBe(30);
    expect(barely.pipeline.press({ kind: "further_back" })).toEqual({ accepted: false, reason: "nothing_more" });
    expect(barely.net.requests).toHaveLength(1);
  });

  it("retries on the other route with the same clip", async () => {
    const { pipeline, events, net, server } = setup();
    server.handler = (req, call) => (call === 1 ? errorEventResponse("provider_error", { route: "open_weights", cause: "http" }) : sseResponse(okSteps(wireA), req.signal));
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(events, "error")[0]).toMatchObject({ code: "provider_error", route: "open_weights", cause: "http", sent: true });
    expect(pipeline.press({ kind: "retry", route: "meta_api" }).accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(metaOf(net.requests[1])).toMatchObject({ route: "meta_api", windowSec: 30 });
    expect(ofType(events, "card")[0].card.meta.route).toBe("meta_api");
  });

  it("shows a sample's saved card when the live call fails, labeled as a stand-in for this press", async () => {
    const saved = Card.parse({
      ...wireB,
      meta: {
        id: "saved-1",
        pressedAt: "2026-11-03T09:00:00.000-05:00",
        windowSec: 30,
        sentSec: 24.5,
        cardLang: "en",
        source: "sample",
        route: "cached",
        model: "meta-models/muse-spark-open-1026",
        ms: { total: 2_900, firstToken: 1_100 },
        bytesSent: 784_044,
        sent: { body: "audio", names: false, hint: false },
        cachedFrom: "open_weights",
        cachedRunAt: "2026-11-03",
      },
    });
    vi.mocked(getCachedCard).mockReturnValue(saved);
    const spec: CaptureSourceSpec = { kind: "sample", clipId: "ask-by-name", url: "/samples/ask-by-name.wav" };
    const { pipeline, events, server } = setup({ spec });
    server.handler = () => errorEventResponse("live_off");
    const pressedAt = Date.now();
    pipeline.press({ kind: "new", pressedAt });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(getCachedCard).toHaveBeenCalledWith("ask-by-name", "en");
    expect(ofType(events, "error")).toHaveLength(0);
    const { card, server: timing } = ofType(events, "card")[0];
    expect(timing).toBeNull();
    expect(Card.safeParse(card).success).toBe(true);
    expect(card.meta.id).not.toBe("saved-1");
    expect(card.meta).toMatchObject({
      route: "cached",
      cachedFrom: "open_weights",
      cachedRunAt: "2026-11-03",
      model: "meta-models/muse-spark-open-1026",
      ms: { total: 2_900, firstToken: 1_100 },
      pressedAt: toLocalIso(pressedAt),
      sent: { body: "audio", names: true, hint: true },
      cachedBecause: "live_off",
    });
    expect(saved.meta.id).toBe("saved-1"); // the catalog's card is untouched
    expect(saved.meta.cachedBecause).toBeUndefined();
  });

  it("sends a sample's listener names and meeting language instead of the visitor's own", async () => {
    const clip = { id: "ask-by-name", listenerNames: ["Sam", "サム"], meetingLang: "en" } as unknown as SampleClip;
    vi.mocked(getSampleClip).mockImplementation((id) => (id === "ask-by-name" ? clip : null));
    const spec: CaptureSourceSpec = { kind: "sample", clipId: "ask-by-name", url: "/samples/ask-by-name.wav" };
    const { pipeline, events, net } = setup({ spec });
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getSampleClip).toHaveBeenCalledWith("ask-by-name");
    expect(ofType(events, "pressed")[0].stall).toEqual({ text: "stall-en", lang: "en" });
    expect(metaOf(net.requests[0])).toMatchObject({ source: "sample", names: ["Sam", "サム"], meetingLang: "en" });
    expect(metaOf(net.requests[0])).not.toHaveProperty("hint"); // the visitor's session hint stays home
    expect(ofType(events, "card")[0].card.meta.sent.hint).toBe(false);

    const live = setup();
    live.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(metaOf(live.net.requests[0])).toMatchObject({ source: "mic", names: ["Seika", "セイカ"], meetingLang: "ja", hint: "Dr. Rivera, BIO-110" });
  });

  it("lets Retry run the same press again after an Unformatted card", async () => {
    const { pipeline, events, server, net } = setup();
    const raw: WireCard = {
      ...wireB,
      summary: ['{"heard":"clear","ask":'],
      meta: { ...wireB.meta, parse: "unformatted", unformatted: true },
    };
    server.handler = (req, call) => sseResponse(call === 1 ? okSteps(raw) : okSteps(), req.signal);
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    const first = ofType(events, "card")[0];
    expect(first.card.meta.unformatted).toBe(true);

    expect(pipeline.press({ kind: "retry" }).accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(net.requests).toHaveLength(2);
    const second = ofType(events, "card")[1];
    expect(second.replaces).toBe(first.card.meta.id);
    expect(second.card.meta.unformatted).toBeUndefined();
    expect(pipeline.press({ kind: "retry" }).accepted).toBe(false); // a clean card leaves nothing to retry
  });

  it("keeps the error when a sample has no saved card, and never stands in for mock", async () => {
    const spec: CaptureSourceSpec = { kind: "sample", clipId: "dev-clip", url: "/samples/dev/clip.wav" };
    const plain = setup({ spec });
    plain.server.handler = () => errorEventResponse("live_off");
    plain.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(plain.events, "error")[0].code).toBe("live_off");

    vi.mocked(getCachedCard).mockImplementation(() => {
      throw new Error("should not be asked for mock");
    });
    const mock = setup({ spec, settings: { route: "mock", mock: { mode: "error" } } });
    mock.server.handler = () => errorEventResponse("provider_error");
    mock.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(mock.events, "error")[0].code).toBe("provider_error");
    expect(metaOf(mock.net.requests[0])).toMatchObject({ route: "mock", mock: { mode: "error" } });
  });

  it("sends nothing while offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { pipeline, events, net } = setup();
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ofType(events, "error")).toEqual([
      { type: "error", pressId: expect.any(String), code: "offline", retryable: true, sent: false },
    ]);
    expect(net.requests).toHaveLength(0);
    expect(pipeline.heldUntil()).not.toBeNull(); // the clip stays for Retry
  });

  it("zeroes the held press after two minutes and after a pause", async () => {
    const timed = setup();
    timed.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(LIMITS.snapshotHoldMs);
    expect(timed.events[timed.events.length - 1]).toEqual({ type: "held", until: null });
    expect(timed.pipeline.heldUntil()).toBeNull();
    expect(timed.snapshots[0].released).toBe(true);
    expect(timed.pipeline.press({ kind: "further_back" })).toEqual({ accepted: false, reason: "nothing_held" });

    const paused = setup();
    paused.pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    await paused.engine.pause();
    expect(paused.events[paused.events.length - 1]).toEqual({ type: "held", until: null });
    expect(paused.pipeline.press({ kind: "language", cardLang: "zh" })).toEqual({ accepted: false, reason: "nothing_held" });
  });

  it("reports aborted, not bad audio, when Pause lands before the snapshot", async () => {
    const { pipeline, events, engine, setStatus, net } = setup();
    vi.mocked(engine.snapshot).mockImplementationOnce(async () => {
      setStatus({ state: "paused", source: "mic", reason: "user" });
      throw new Error("Capture was paused");
    });
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(100);
    expect(ofType(events, "error")).toEqual([
      { type: "error", pressId: expect.any(String), code: "aborted", retryable: false, sent: false },
    ]);
    expect(net.requests).toHaveLength(0);
  });

  it("dispose mid-press emits aborted, zeroes the held clip and drops listeners", async () => {
    const { pipeline, events, server, snapshots } = setup();
    server.handler = (req) => pending(req);
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(500);
    pipeline.dispose();
    expect(events.slice(-2)).toEqual([
      { type: "error", pressId: expect.any(String), code: "aborted", retryable: false, sent: true },
      { type: "held", until: null },
    ]);
    expect(snapshots[0].released).toBe(true);
    const count = events.length;
    expect(pipeline.press({ kind: "new", pressedAt: Date.now() }).accepted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toHaveLength(count);
  });

  it("falls back to an English stall line if the card strings fail", async () => {
    const strings = await import("@/lib/card/strings");
    const spy = vi.spyOn(strings, "stallLine").mockImplementation(() => {
      throw new Error("not implemented");
    });
    const { pipeline, events } = setup();
    pipeline.press({ kind: "new", pressedAt: Date.now() });
    expect(events[0]).toMatchObject({ type: "pressed", stall: { text: "Let me think about that for a second.", lang: "en" } });
    spy.mockRestore();
    await vi.advanceTimersByTimeAsync(5_000);
  });
});

describe("session id", () => {
  it("matches the header pattern and differs each time", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(a).not.toBe(b);
  });
});
