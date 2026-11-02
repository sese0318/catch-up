// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CaptureEngine,
  CaptureEvent,
  CaptureSourceSpec,
  CaptureStatus,
  CaptureSupport,
  CatchUpDesktopBridge,
  DesktopHotkeyState,
  DesktopPressPayload,
  LevelReading,
  PressEvent,
  PressPipeline,
  PressRequest,
  PressResult,
} from "../audio/types";
import { SessionController, type ControllerDeps } from "./controller";
import { createSettingsStore } from "./settings";
import { makeCard } from "./test-helpers";

const SUPPORT: CaptureSupport = {
  secureContext: true,
  audioWorklet: true,
  mic: true,
  tab: true,
  system: true,
  desktopApp: false,
  phone: false,
  nativeRate: false,
};

function fakeEngine() {
  let status: CaptureStatus = { state: "idle" };
  let source: CaptureSourceSpec | null = null;
  const subs = new Set<() => void>();
  const levels = new Set<(r: LevelReading) => void>();
  const events = new Set<(e: CaptureEvent) => void>();
  const starts: CaptureSourceSpec[] = [];
  const notify = () => subs.forEach((f) => f());
  const engine = {
    starts,
    memory: 2,
    getStatus: () => status,
    getSource: () => source,
    subscribe(listener: () => void) {
      subs.add(listener);
      return () => void subs.delete(listener);
    },
    onLevel(listener: (r: LevelReading) => void) {
      levels.add(listener);
      return () => void levels.delete(listener);
    },
    onEvent(listener: (e: CaptureEvent) => void) {
      events.add(listener);
      return () => void events.delete(listener);
    },
    start: vi.fn((spec: CaptureSourceSpec) => {
      starts.push(spec);
      source = spec;
      status = { state: "listening", source: spec.kind, startedAt: 1 };
      notify();
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      status = { state: "paused", source: status.state === "listening" ? status.source : null, reason: "user" };
      notify();
      return Promise.resolve();
    }),
    stop: vi.fn(() => Promise.resolve()),
    memorySeconds() {
      return engine.memory;
    },
    snapshot: vi.fn(),
    setStatus(next: CaptureStatus) {
      status = next;
      notify();
    },
    level(reading: LevelReading) {
      levels.forEach((f) => f(reading));
    },
    event(e: CaptureEvent) {
      events.forEach((f) => f(e));
    },
  };
  return engine;
}

function fakePipeline() {
  const listeners = new Set<(e: PressEvent) => void>();
  const presses: PressRequest[] = [];
  let next: PressResult | null = null;
  const pipeline = {
    presses,
    refuseNext(result: PressResult) {
      next = result;
    },
    press: vi.fn((request: PressRequest): PressResult => {
      presses.push(request);
      const out = next ?? { accepted: true, pressId: `p${presses.length}` };
      next = null;
      return out;
    }),
    cancel: vi.fn(),
    isBusy: () => false,
    heldUntil: () => null,
    on(listener: (e: PressEvent) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispose: vi.fn(),
    emit(e: PressEvent) {
      listeners.forEach((f) => f(e));
    },
  };
  return pipeline;
}

function fakeBridge() {
  let onHotkey: ((p: DesktopPressPayload) => void) | null = null;
  let onHotkeyChange: ((s: DesktopHotkeyState) => void) | null = null;
  let onCommand: ((c: "pause" | "resume") => void) | null = null;
  const hotkey: DesktopHotkeyState = { accelerator: "Control+Alt+C", registered: true, error: null };
  const bridge = {
    isDesktop: true as const,
    bridgeVersion: 1 as const,
    onHotkey: (cb: (p: DesktopPressPayload) => void) => {
      onHotkey = cb;
      return () => undefined;
    },
    onHotkeyChange: (cb: (s: DesktopHotkeyState) => void) => {
      onHotkeyChange = cb;
      return () => undefined;
    },
    onCommand: (cb: (c: "pause" | "resume") => void) => {
      onCommand = cb;
      return () => undefined;
    },
    onViewChange: () => () => undefined,
    getView: vi.fn(() => Promise.resolve("compact" as const)),
    setView: vi.fn((v: "compact" | "full") => Promise.resolve(v)),
    getHotkey: vi.fn(() => Promise.resolve(hotkey)),
    setHotkey: vi.fn(() => Promise.resolve(hotkey)),
    setTrayState: vi.fn(() => Promise.resolve()),
    showPanel: vi.fn(() => Promise.resolve()),
    copyText: vi.fn(() => Promise.resolve(true)),
    hideWindow: vi.fn(() => Promise.resolve()),
    fireHotkey(p: DesktopPressPayload) {
      onHotkey?.(p);
    },
    fireHotkeyChange(s: DesktopHotkeyState) {
      onHotkeyChange?.(s);
    },
    fireCommand(c: "pause" | "resume") {
      onCommand?.(c);
    },
  };
  return bridge;
}

const healthJson = {
  ok: true,
  v: 1,
  live: true,
  paused: null,
  defaultRoute: "auto",
  mock: false,
  routes: {
    open_weights: { configured: true, model: "meta-models/muse-spark-open-1026", provider: "Baseten" },
    meta_api: { configured: true, model: "muse-voice-transcribe-1.0 + muse-spark-1.3", provider: "Meta" },
  },
  limits: { maxBodyBytes: 4_400_000, maxClipSec: 125, perHour: 30, hardCapMs: 20_000 },
};

function setup(options: { bridge?: ReturnType<typeof fakeBridge>; brokenEngine?: boolean; support?: Partial<CaptureSupport> } = {}) {
  const engine = fakeEngine();
  const pipeline = fakePipeline();
  const settings = createSettingsStore();
  const deps: ControllerDeps = {
    createEngine: () => {
      if (options.brokenEngine) throw new Error("not implemented");
      return engine as unknown as CaptureEngine;
    },
    createPipeline: () => pipeline as unknown as PressPipeline,
    sessionId: () => "session-test-1234",
    support: () => ({ ...SUPPORT, ...options.support }),
    bridge: () => (options.bridge ?? null) as unknown as CatchUpDesktopBridge | null,
    fetchImpl: vi.fn(() => Promise.resolve(new Response(JSON.stringify(healthJson), { status: 200 }))) as unknown as typeof fetch,
    settings,
    win: window,
    now: () => Date.now(),
  };
  const ctl = new SessionController(deps);
  const unsubscribe = ctl.subscribe(() => undefined);
  return { ctl, engine, pipeline, settings, deps, unsubscribe };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let current: ReturnType<typeof setup> | null = null;
afterEach(() => {
  current?.unsubscribe();
  current?.ctl.dispose();
  current = null;
  window.localStorage.clear();
  document.title = "Catch Up";
});

describe("session controller", () => {
  it("sets up on the first subscription and reads health", async () => {
    current = setup();
    const { ctl, deps } = current;
    expect(ctl.getSnapshot().initialized).toBe(true);
    expect(ctl.getSnapshot().support.tab).toBe(true);
    await flush();
    expect(deps.fetchImpl).toHaveBeenCalledWith("/api/health", expect.objectContaining({ cache: "no-store" }));
    expect(ctl.getSnapshot().health.state).toBe("ok");
  });

  it("starts listening only after People here know, inside the click", () => {
    current = setup();
    const { ctl, engine } = current;
    expect(ctl.startLive("tab")).toBe(false);
    expect(engine.start).not.toHaveBeenCalled();
    ctl.setConsent(true);
    expect(ctl.startLive("tab")).toBe(true);
    expect(engine.start).toHaveBeenCalledTimes(1); // synchronous, nothing awaited first
    expect(engine.starts[0]).toEqual({ kind: "tab" });
    expect(ctl.getSnapshot().capture).toMatchObject({ state: "listening", source: "tab" });
    expect(document.title).toBe("● Catch Up");
    ctl.pause();
    expect(ctl.getSnapshot().capture).toMatchObject({ state: "paused", reason: "user" });
    expect(document.title).toBe("Catch Up");
    expect(ctl.resume()).toBe(true);
    expect(engine.starts[1]).toEqual({ kind: "tab" });
  });

  it("turns pipeline events into the card, and refusals into notices", () => {
    current = setup();
    const { ctl, pipeline, engine } = current;
    ctl.setConsent(true);
    ctl.startLive("mic");
    expect(ctl.catchUp(1_234)).toBe(true);
    expect(pipeline.presses[0]).toEqual({ kind: "new", pressedAt: 1_234 });
    pipeline.emit({ type: "pressed", pressId: "p1", kind: "new", pressedAt: 1_234, startedAt: 1_234, stall: { text: "x", lang: "en" } });
    expect(ctl.isBusy()).toBe(true);
    const card = makeCard();
    pipeline.emit({ type: "card", pressId: "p1", card, replaces: null, server: null });
    expect(ctl.getSnapshot().core.currentId).toBe(card.meta.id);

    engine.memory = 2.2;
    pipeline.refuseNext({ accepted: false, reason: "warming_up" });
    expect(ctl.catchUp(2_000)).toBe(false);
    expect(ctl.getSnapshot().notice).toMatchObject({ kind: "warming_up", secondsLeft: 3 });
    pipeline.refuseNext({ accepted: false, reason: "busy" });
    ctl.catchUp(3_000);
    expect(ctl.getSnapshot().notice?.kind).toBe("warming_up"); // busy presses are ignored quietly
    pipeline.refuseNext({ accepted: false, reason: "nothing_held" });
    ctl.furtherBack();
    expect(ctl.getSnapshot().notice?.kind).toBe("nothing_held");
    expect(pipeline.presses.at(-1)).toEqual({ kind: "further_back" });
    expect(ctl.getSnapshot().core.announcement?.parts[0].text).toBe("That clip was cleared after 2 minutes. Press Catch up for a new one.");
    ctl.clearNotice();
    pipeline.refuseNext({ accepted: false, reason: "nothing_more" });
    ctl.furtherBack();
    expect(ctl.getSnapshot().notice).toBeNull(); // nothing older to send, and never the cleared notice
    ctl.redoLanguage("ja");
    expect(pipeline.presses.at(-1)).toEqual({ kind: "language", cardLang: "ja" });
    ctl.retry("meta_api");
    expect(pipeline.presses.at(-1)).toEqual({ kind: "retry", route: "meta_api" });
  });

  it("handles Ctrl+Alt+C and Esc in the page, but not while an IME composes", () => {
    current = setup();
    const { ctl, pipeline } = current;
    ctl.setConsent(true);
    ctl.startLive("mic");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, altKey: true, isComposing: true }));
    expect(pipeline.press).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, altKey: true, cancelable: true }));
    expect(pipeline.presses[0]).toMatchObject({ kind: "new" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC" }));
    expect(pipeline.presses).toHaveLength(1); // no single-letter shortcut

    pipeline.emit({ type: "pressed", pressId: "p1", kind: "new", pressedAt: 1, startedAt: 1, stall: { text: "x", lang: "en" } });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", cancelable: true }));
    expect(pipeline.cancel).toHaveBeenCalledTimes(1);

    pipeline.emit({ type: "card", pressId: "p1", card: makeCard(), replaces: null, server: null });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", cancelable: true }));
    expect(ctl.getSnapshot().core.currentId).toBeNull(); // Esc moves the card into history
    expect(ctl.getSnapshot().core.cards).toHaveLength(1);
  });

  it("never blocks Quit or Reload in the Windows app with the leave warning", async () => {
    const bridge = fakeBridge();
    current = setup({ bridge });
    const { pipeline } = current;
    await flush();
    pipeline.emit({ type: "card", pressId: "p1", card: makeCard(), replaces: null, server: null });
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
  });

  it("announces capture problems through the live region", () => {
    current = setup();
    const { ctl, engine } = current;
    ctl.setConsent(true);
    ctl.startLive("tab");
    engine.setStatus({ state: "error", source: "tab", code: "no_audio_in_share" });
    expect(ctl.getSnapshot().core.announcement).toMatchObject({
      assertive: true,
      parts: [{ lang: "en", text: expect.stringContaining("The share came back without sound.") }],
    });
    engine.setStatus({ state: "paused", source: "tab", reason: "source_lost" });
    expect(ctl.getSnapshot().core.announcement?.parts[0].text).toBe("Stopped hearing the meeting tab.");
  });

  it("warns before leaving with unexported cards", () => {
    current = setup();
    const { ctl, pipeline } = current;
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    pipeline.emit({ type: "card", pressId: "p1", card: makeCard(), replaces: null, server: null });
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    ctl.markExported();
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("follows a sample from play to the key moment pulse", () => {
    current = setup();
    const { ctl, engine } = current;
    ctl.playSample({
      id: "ask-by-name",
      title: "An English ask by name",
      blurb: "x",
      url: "/samples/ask-by-name.mp3",
      durationSec: 24,
      spokenLangs: ["en"],
      muffle: { startSec: 10, endSec: 14 },
      keyMomentSec: 13,
      consent: "written",
      cached: {},
    });
    expect(engine.starts[0]).toMatchObject({ kind: "sample", clipId: "ask-by-name", keyMomentSec: 13 });
    expect(ctl.getSnapshot().sample).toMatchObject({ phase: "playing", pulseSeq: 0 });
    engine.event({ type: "sample", phase: "playing", currentSec: 11, muffled: true, keyMomentPassed: false });
    expect(ctl.getSnapshot().sample?.muffled).toBe(true);
    engine.event({ type: "sample", phase: "playing", currentSec: 13.2, muffled: false, keyMomentPassed: true });
    engine.event({ type: "sample", phase: "playing", currentSec: 14, muffled: false, keyMomentPassed: true });
    expect(ctl.getSnapshot().sample).toMatchObject({ keyMomentPassed: true, pulseSeq: 1 });
    engine.setStatus({ state: "paused", source: "sample", reason: "sample_ended" });
    expect(ctl.getSnapshot().sample).toBeNull();
  });

  it("folds the level meter into Sound OK and flags a quiet source", () => {
    current = setup();
    const { ctl, engine } = current;
    ctl.setConsent(true);
    ctl.startLive("mic");
    const reading = (at: number, patch: Partial<LevelReading>): LevelReading => ({
      at,
      rms: 0.1,
      peak: 0.3,
      speech: true,
      memorySec: at / 1000,
      quiet: false,
      ...patch,
    });
    engine.level(reading(1_000, {}));
    expect(ctl.getLevel().soundOk).toBe(false);
    engine.level(reading(11_500, { speech: false }));
    expect(ctl.getLevel().soundOk).toBe(true);
    engine.level(reading(40_000, { speech: false, quiet: true }));
    expect(ctl.getLevel()).toMatchObject({ soundOk: false, quiet: true });
  });

  it("drives the Windows app bridge", async () => {
    const bridge = fakeBridge();
    current = setup({ bridge });
    const { ctl, pipeline, engine } = current;
    await flush();
    expect(ctl.getSnapshot().desktop).toMatchObject({ present: true, view: "compact" });
    expect(ctl.getSnapshot().desktop.hotkey?.registered).toBe(true);
    expect(ctl.getSnapshot().support.desktopApp).toBe(true);
    expect(ctl.getSnapshot().pip.supported).toBe(false);

    ctl.setConsent(true);
    ctl.startLive("system");
    expect(bridge.setTrayState).toHaveBeenLastCalledWith({ listening: true, problem: null });
    bridge.fireHotkey({ at: 5_555, via: "hotkey", accelerator: "Control+Alt+C" });
    expect(pipeline.presses.at(-1)).toEqual({ kind: "new", pressedAt: 5_555 });
    bridge.fireHotkey({ at: 6_666, via: "tray", accelerator: null });
    expect(pipeline.presses.at(-1)).toEqual({ kind: "new", pressedAt: 6_666 });

    // The global hotkey owns Ctrl+Alt+C, so the page does not press twice.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, altKey: true }));
    expect(pipeline.presses).toHaveLength(2);

    bridge.fireCommand("pause");
    expect(engine.pause).toHaveBeenCalled();
    expect(bridge.setTrayState).toHaveBeenLastCalledWith({ listening: false, problem: null });
    bridge.fireCommand("resume");
    expect(engine.starts.at(-1)).toEqual({ kind: "system" });

    engine.setStatus({ state: "paused", source: "system", reason: "source_lost" });
    expect(bridge.setTrayState).toHaveBeenLastCalledWith({ listening: false, problem: "Stopped hearing system audio." });

    bridge.fireHotkeyChange({ accelerator: "Control+Shift+Space", registered: true, error: null });
    expect(ctl.getSnapshot().desktop.hotkey?.accelerator).toBe("Control+Shift+Space");
    ctl.setDesktopView("full");
    expect(bridge.setView).toHaveBeenCalledWith("full");
  });

  it("stays usable when the audio lane is not there yet", () => {
    current = setup({ brokenEngine: true });
    const { ctl } = current;
    expect(ctl.getSnapshot().unavailable).toBe(true);
    ctl.setConsent(true);
    expect(ctl.startLive("mic")).toBe(false);
    expect(ctl.getSnapshot().notice?.kind).toBe("unavailable");
    expect(ctl.catchUp(1)).toBe(false);
  });

  it("builds press settings from settings, the hint and the route plan", async () => {
    current = setup();
    const { ctl, settings } = current;
    await flush();
    settings.update({ cardLang: "ja", meetingLang: "en", windowSec: 60, route: "open_weights" });
    settings.setName(0, "Seika");
    ctl.setHint("BIO-110");
    const out = ctl.pressSettings();
    expect(out).toMatchObject({
      cardLang: "ja",
      meetingLang: "en",
      windowSec: 60,
      route: "open_weights",
      hint: "BIO-110",
      names: ["Seika", "", ""],
      live: { liveOff: false, defaultRoute: "auto", configured: ["open_weights", "meta_api"] },
    });
    expect(out.mock).toBeUndefined();
  });
});
