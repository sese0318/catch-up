// The page's session controller. Plain TypeScript outside React, read with useSyncExternalStore.
// It owns the capture engine and the press pipeline (only through their contracts), turns press
// events into what the panel shows, and wires the browser bits that are not rendering. Hotkeys,
// the leave warning, the tab title, the phone wake lock, the floating window and the Windows app
// bridge. Nothing here stores audio or card text anywhere but memory.
import { createCaptureEngine, getCaptureSupport } from "../audio/engine";
import {
  getDesktopBridge,
  type CaptureEngine,
  type CaptureEvent,
  type CaptureSourceSpec,
  type CaptureStatus,
  type CaptureSupport,
  type CatchUpDesktopBridge,
  type DesktopHotkeyPreset,
  type DesktopHotkeyState,
  type DesktopTrayState,
  type DesktopView,
  type LevelReading,
  type PressDeps,
  type PressEvent,
  type PressPipeline,
  type PressRequest,
  type PressSettings,
} from "../audio/types";
import type { CardLang } from "../card/schema";
import { createPressPipeline, newSessionId } from "../press/press";
import { HEALTH_ENDPOINT, LIMITS, type MockSpec, type RoutePreference } from "../protocol";
import type { SampleClip } from "../samples/catalog";
import { sourceLostLabel, quietHint } from "./copy";
import { eventEpochMs, isCatchUpCombo, isComposing, isEscape } from "./hotkey";
import { openPipWindow, syncRootAttributes, isDocPipSupported } from "./pip";
import { parseHealth, parseMockParam, planRoute, type HealthView } from "./route";
import { INITIAL_CORE, sessionReducer, type SessionAction, type SessionCore } from "./session-state";
import { getSettingsStore, type LiveSource, type SettingsStore } from "./settings";
import { createWakeLock, type WakeLockHandle } from "./wake-lock";

export interface SampleView {
  clipId: string;
  title: string;
  phase: "playing" | "ended";
  currentSec: number;
  durationSec: number;
  muffled: boolean;
  keyMomentPassed: boolean;
  /** Bumps once when the key moment passes, so the button pulses once. */
  pulseSeq: number;
}

export type NoticeKind = "not_listening" | "warming_up" | "nothing_held" | "unavailable";
export interface NoticeView {
  kind: NoticeKind;
  seq: number;
  secondsLeft?: number;
}

export interface DesktopSnapshot {
  present: boolean;
  view: DesktopView;
  hotkey: DesktopHotkeyState | null;
}

export interface PipSnapshot {
  supported: boolean;
  window: Window | null;
  /** The window closed without Bring back, for example another site's floating window took the slot. */
  closedUnexpectedly: boolean;
}

export interface ControllerSnapshot {
  initialized: boolean;
  /** The engine or the press pipeline could not be created (a lane still in progress). */
  unavailable: boolean;
  support: CaptureSupport;
  capture: CaptureStatus;
  source: CaptureSourceSpec | null;
  /** People here know, for this page session only. */
  consent: boolean;
  /** Names or topics to expect, for this page session only. */
  hint: string;
  core: SessionCore;
  sample: SampleView | null;
  notice: NoticeView | null;
  health: HealthView;
  mockParam: MockSpec | null;
  pip: PipSnapshot;
  desktop: DesktopSnapshot;
  lastLiveSource: LiveSource | null;
}

export interface LevelView {
  reading: LevelReading | null;
  quiet: boolean;
  /** The meter folds into a still Sound OK tick after 10 s of good signal. */
  soundOk: boolean;
}

const NO_SUPPORT: CaptureSupport = {
  secureContext: false,
  audioWorklet: false,
  mic: false,
  tab: false,
  system: false,
  desktopApp: false,
  phone: false,
  nativeRate: false,
};

export const SERVER_SNAPSHOT: ControllerSnapshot = {
  initialized: false,
  unavailable: false,
  support: NO_SUPPORT,
  capture: { state: "idle" },
  source: null,
  consent: false,
  hint: "",
  core: INITIAL_CORE,
  sample: null,
  notice: null,
  health: { state: "loading" },
  mockParam: null,
  pip: { supported: false, window: null, closedUnexpectedly: false },
  desktop: { present: false, view: "full", hotkey: null },
  lastLiveSource: null,
};

const EMPTY_LEVEL: LevelView = { reading: null, quiet: false, soundOk: false };

export interface ControllerDeps {
  createEngine: () => CaptureEngine;
  createPipeline: (deps: PressDeps) => PressPipeline;
  sessionId: () => string;
  support: () => CaptureSupport;
  bridge: () => CatchUpDesktopBridge | null;
  fetchImpl: typeof fetch;
  settings: SettingsStore;
  win: Window | null;
  now: () => number;
}

function defaultDeps(): ControllerDeps {
  const win = typeof window === "undefined" ? null : window;
  return {
    createEngine: () => createCaptureEngine(),
    createPipeline: (deps) => createPressPipeline(deps),
    sessionId: () => newSessionId(),
    support: () => getCaptureSupport(),
    bridge: () => getDesktopBridge(),
    fetchImpl: (input, init) => fetch(input, init),
    settings: getSettingsStore(),
    win,
    now: () => Date.now(),
  };
}

function fallbackSupport(win: Window | null): CaptureSupport {
  if (!win) return NO_SUPPORT;
  const nav = win.navigator;
  const phone =
    /Android|iPhone|iPad|iPod/i.test(nav.userAgent) || (nav.maxTouchPoints > 1 && /Macintosh/.test(nav.userAgent));
  const media = nav.mediaDevices;
  return {
    secureContext: win.isSecureContext,
    audioWorklet: typeof (win as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode !== "undefined",
    mic: typeof media?.getUserMedia === "function",
    tab: !phone && typeof media?.getDisplayMedia === "function",
    system: false,
    desktopApp: getDesktopBridge() !== null,
    phone,
    nativeRate: false,
  };
}

function liveSpec(kind: LiveSource): CaptureSourceSpec {
  if (kind === "tab") return { kind: "tab" };
  if (kind === "system") return { kind: "system" };
  return { kind: "mic" };
}

export class SessionController {
  private snap: ControllerSnapshot = SERVER_SNAPSHOT;
  private level: LevelView = EMPTY_LEVEL;
  private readonly listeners = new Set<() => void>();
  private readonly levelListeners = new Set<() => void>();
  private readonly cleanups: Array<() => void> = [];
  private deps: ControllerDeps | null;
  private engine: CaptureEngine | null = null;
  private pipeline: PressPipeline | null = null;
  private bridge: CatchUpDesktopBridge | null = null;
  private wake: WakeLockHandle | null = null;
  private initializedOnce = false;
  private noticeSeq = 0;
  private goodSince: number | null = null;
  private lastTray = "";
  private baseTitle = "";
  private closingPip = false;
  private pipKeyCleanup: (() => void) | null = null;

  constructor(deps?: ControllerDeps) {
    this.deps = deps ?? null;
  }

  // Store protocol (arrow functions so React can pass them around)

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.init();
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ControllerSnapshot => this.snap;
  getServerSnapshot = (): ControllerSnapshot => SERVER_SNAPSHOT;

  subscribeLevel = (listener: () => void): (() => void) => {
    this.levelListeners.add(listener);
    this.init();
    return () => {
      this.levelListeners.delete(listener);
    };
  };

  getLevel = (): LevelView => this.level;
  getServerLevel = (): LevelView => EMPTY_LEVEL;

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private patch(next: Partial<ControllerSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    this.emit();
  }

  private dispatch(action: SessionAction): void {
    const core = sessionReducer(this.snap.core, action);
    if (core !== this.snap.core) this.patch({ core });
  }

  // Setup

  /** Runs once, on the first subscription in the browser. Never during server rendering. */
  init(): void {
    if (this.initializedOnce) return;
    const deps = this.deps ?? (typeof window === "undefined" ? null : defaultDeps());
    if (!deps || !deps.win) return;
    this.deps = deps;
    this.initializedOnce = true;
    const win = deps.win;

    let support: CaptureSupport;
    try {
      support = deps.support();
    } catch {
      support = fallbackSupport(win);
    }

    let unavailable = false;
    try {
      this.engine = deps.createEngine();
      this.pipeline = deps.createPipeline({
        engine: this.engine,
        getSettings: () => this.pressSettings(),
        sessionId: deps.sessionId(),
      });
    } catch {
      unavailable = true;
      this.pipeline = null;
    }

    const engine = this.engine;
    if (engine && !unavailable) {
      this.cleanups.push(engine.subscribe(() => this.onCapture()));
      this.cleanups.push(engine.onLevel((reading) => this.onLevel(reading)));
      this.cleanups.push(engine.onEvent((event) => this.onCaptureEvent(event)));
    }
    if (this.pipeline) this.cleanups.push(this.pipeline.on((event) => this.onPressEvent(event)));

    this.bridge = deps.bridge();
    const bridge = this.bridge;
    if (bridge) {
      this.cleanups.push(bridge.onHotkey((payload) => this.catchUp(payload.at)));
      this.cleanups.push(bridge.onHotkeyChange((hotkey) => this.patch({ desktop: { ...this.snap.desktop, hotkey } })));
      this.cleanups.push(bridge.onCommand((command) => (command === "pause" ? this.pause() : this.resume())));
      this.cleanups.push(bridge.onViewChange((view) => this.patch({ desktop: { ...this.snap.desktop, view } })));
      void bridge.getView().then(
        (view) => this.patch({ desktop: { ...this.snap.desktop, view } }),
        () => undefined,
      );
      void bridge.getHotkey().then(
        (hotkey) => this.patch({ desktop: { ...this.snap.desktop, hotkey } }),
        () => undefined,
      );
    }

    if (support.phone) this.wake = createWakeLock(win.document, win.navigator);

    const onKey = (e: KeyboardEvent) => this.onKeyDown(e);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (this.snap.core.unexported && this.snap.core.cards.length > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const onPageHide = (e: PageTransitionEvent) => {
      if (!e.persisted) void this.engine?.stop().catch(() => undefined);
    };
    win.addEventListener("keydown", onKey);
    win.addEventListener("beforeunload", onBeforeUnload);
    win.addEventListener("pagehide", onPageHide);
    this.cleanups.push(() => {
      win.removeEventListener("keydown", onKey);
      win.removeEventListener("beforeunload", onBeforeUnload);
      win.removeEventListener("pagehide", onPageHide);
    });
    this.cleanups.push(
      deps.settings.subscribe(() => {
        const pipWin = this.snap.pip.window;
        if (pipWin) syncRootAttributes(pipWin, win.document);
      }),
    );

    this.baseTitle = win.document.title.replace(/^● /, "") || "Catch Up";

    this.snap = {
      ...this.snap,
      initialized: true,
      unavailable,
      support: { ...support, desktopApp: support.desktopApp || bridge !== null },
      capture: engine && !unavailable ? engine.getStatus() : { state: "idle" },
      mockParam: parseMockParam(win.location.search),
      pip: { supported: !bridge && isDocPipSupported(), window: null, closedUnexpectedly: false },
      desktop: { present: bridge !== null, view: bridge ? "compact" : "full", hotkey: null },
    };
    queueMicrotask(() => this.emit());
    void this.loadHealth();
  }

  async loadHealth(): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    try {
      const res = await deps.fetchImpl(HEALTH_ENDPOINT, { cache: "no-store", headers: { accept: "application/json" } });
      const data = res.ok ? parseHealth(await res.json()) : null;
      this.patch({ health: data ? { state: "ok", data } : { state: "unavailable" } });
    } catch {
      this.patch({ health: { state: "unavailable" } });
    }
  }

  /** Read by the press pipeline at press time. */
  pressSettings(): PressSettings {
    const deps = this.deps;
    const { settings } = (deps?.settings ?? getSettingsStore()).getSnapshot();
    const plan = planRoute(settings.route, this.snap.health, this.snap.mockParam);
    let tz: string | undefined;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
      tz = undefined;
    }
    const out: PressSettings = {
      cardLang: settings.cardLang,
      meetingLang: settings.meetingLang,
      windowSec: settings.windowSec,
      names: [...settings.names],
      hint: this.snap.hint,
      route: plan.route,
      tz,
    };
    if (plan.mock) out.mock = plan.mock;
    return out;
  }

  // Engine and pipeline events

  private onCapture(): void {
    const engine = this.engine;
    if (!engine) return;
    const capture = engine.getStatus();
    const source = engine.getSource();
    const next: Partial<ControllerSnapshot> = { capture, source };
    // A sample start passes through paused (replaced) and starting before it plays.
    const keepSample =
      ((capture.state === "listening" || capture.state === "starting") && capture.source === "sample") ||
      (capture.state === "paused" && capture.reason === "replaced");
    if (!keepSample) next.sample = null;
    if (capture.state !== "listening") this.resetLevel();
    this.patch(next);
    this.wake?.set(this.snap.support.phone && capture.state === "listening");
    this.updateTitle();
    this.updateTray();
  }

  private onLevel(reading: LevelReading): void {
    if (reading.quiet) this.goodSince = null;
    else if (reading.speech && this.goodSince === null) this.goodSince = reading.at;
    const soundOk = this.goodSince !== null && reading.at - this.goodSince >= LIMITS.soundOkFoldMs;
    const quietChanged = reading.quiet !== this.level.quiet;
    this.level = { reading, quiet: reading.quiet, soundOk };
    for (const listener of [...this.levelListeners]) listener();
    if (quietChanged) this.updateTray();
  }

  private resetLevel(): void {
    this.goodSince = null;
    if (this.level === EMPTY_LEVEL) return;
    this.level = EMPTY_LEVEL;
    for (const listener of [...this.levelListeners]) listener();
  }

  private onCaptureEvent(event: CaptureEvent): void {
    if (event.type !== "sample") return;
    const prev = this.snap.sample;
    if (!prev) return;
    const passedNow = event.keyMomentPassed && !prev.keyMomentPassed;
    this.patch({
      sample: {
        ...prev,
        phase: event.phase,
        currentSec: event.currentSec,
        muffled: event.muffled,
        keyMomentPassed: prev.keyMomentPassed || event.keyMomentPassed,
        pulseSeq: passedNow ? prev.pulseSeq + 1 : prev.pulseSeq,
      },
    });
  }

  private onPressEvent(event: PressEvent): void {
    if (event.type === "pressed" && this.snap.notice) this.snap = { ...this.snap, notice: null };
    this.dispatch({ type: "press", event });
    if (event.type === "card" && this.snap.support.phone) {
      try {
        this.deps?.win?.navigator.vibrate?.(50);
      } catch {
        // Vibration is a nicety.
      }
    }
  }

  // Listening

  setConsent(consent: boolean): void {
    this.patch({ consent });
  }

  setHint(hint: string): void {
    this.patch({ hint });
  }

  private notify(kind: NoticeKind, secondsLeft?: number): void {
    this.noticeSeq += 1;
    this.patch({ notice: { kind, seq: this.noticeSeq, secondsLeft } });
  }

  clearNotice(): void {
    if (this.snap.notice) this.patch({ notice: null });
  }

  /**
   * Starts a live source. Call it synchronously inside the click, because the browser prompt needs
   * the click and nothing may be awaited before it. Needs this session's People here know tick.
   */
  startLive(kind: LiveSource): boolean {
    if (!this.snap.consent) return false;
    if (!this.engine || this.snap.unavailable) {
      this.notify("unavailable");
      return false;
    }
    this.resetLevel();
    void this.engine.start(liveSpec(kind)).catch(() => undefined);
    this.patch({ lastLiveSource: kind, sample: null, notice: null });
    return true;
  }

  /** Plays a sample clip into the same ring and pipeline. Live listening stops and memory is wiped. */
  playSample(clip: SampleClip): boolean {
    if (!this.engine || this.snap.unavailable) {
      this.notify("unavailable");
      return false;
    }
    this.resetLevel();
    void this.engine
      .start({ kind: "sample", clipId: clip.id, url: clip.url, muffle: clip.muffle, keyMomentSec: clip.keyMomentSec })
      .catch(() => undefined);
    this.patch({
      sample: {
        clipId: clip.id,
        title: clip.title,
        phase: "playing",
        currentSec: 0,
        durationSec: clip.durationSec,
        muffled: false,
        keyMomentPassed: false,
        pulseSeq: this.snap.sample?.pulseSeq ?? 0,
      },
      notice: null,
    });
    return true;
  }

  /** Stops every track and wipes memory and the held clip. */
  pause(): void {
    void this.engine?.pause().catch(() => undefined);
  }

  /** Starts the last live source again, with empty memory. Needs this session's tick. */
  resume(): boolean {
    const kind = this.snap.lastLiveSource;
    if (!kind) return false;
    return this.startLive(kind);
  }

  // Presses

  press(request: PressRequest): boolean {
    const pipeline = this.pipeline;
    if (!pipeline) {
      this.notify("unavailable");
      return false;
    }
    const result = pipeline.press(request);
    if (result.accepted) return true;
    switch (result.reason) {
      case "not_listening":
        this.notify("not_listening");
        break;
      case "warming_up": {
        const held = this.engine?.memorySeconds() ?? 0;
        this.notify("warming_up", Math.ceil(LIMITS.warmupSec - held));
        break;
      }
      case "nothing_held":
        this.notify("nothing_held");
        break;
      case "busy":
        break; // extra presses while a request is in flight are ignored
    }
    return false;
  }

  catchUp(pressedAt: number): boolean {
    return this.press({ kind: "new", pressedAt });
  }

  furtherBack(): boolean {
    return this.press({ kind: "further_back" });
  }

  redoLanguage(cardLang: CardLang): boolean {
    return this.press({ kind: "language", cardLang });
  }

  sendAnyway(): boolean {
    return this.press({ kind: "send_anyway" });
  }

  retry(route?: RoutePreference): boolean {
    return this.press(route ? { kind: "retry", route } : { kind: "retry" });
  }

  cancel(): void {
    this.pipeline?.cancel();
  }

  isBusy(): boolean {
    return this.snap.core.request.phase === "busy";
  }

  closeCard(): void {
    this.dispatch({ type: "close_card" });
  }

  clearHistory(): void {
    this.dispatch({ type: "clear_history" });
  }

  markExported(): void {
    this.dispatch({ type: "exported" });
  }

  dismissRequest(): void {
    this.dispatch({ type: "dismiss_request" });
  }

  /** Esc. Cancels a press, else closes the card into history, else clears a notice. True when it did something. */
  escape(): boolean {
    if (this.isBusy()) {
      this.cancel();
      return true;
    }
    if (this.snap.core.currentId) {
      this.closeCard();
      return true;
    }
    if (this.snap.core.request.phase !== "idle") {
      this.dismissRequest();
      return true;
    }
    if (this.snap.notice) {
      this.clearNotice();
      return true;
    }
    return false;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (isComposing(e)) return;
    if (isCatchUpCombo(e)) {
      // Inside the Windows app the global hotkey already delivers the press.
      if (this.bridge && this.snap.desktop.hotkey?.registered) return;
      e.preventDefault();
      if (e.repeat) return;
      this.catchUp(eventEpochMs(e));
      return;
    }
    if (isEscape(e) && !e.defaultPrevented) {
      const doc = (e.target as Node | null)?.ownerDocument ?? this.deps?.win?.document;
      if (doc?.querySelector("dialog[open]")) return; // the sheet closes itself
      if (this.escape()) e.preventDefault();
    }
  }

  // Floating window (Document Picture-in-Picture)

  /** Call directly in the Float on top click. */
  openPip(): Promise<boolean> {
    const opening = openPipWindow();
    return opening.then((pipWin) => {
      if (!pipWin) return false;
      this.attachPip(pipWin);
      return true;
    });
  }

  private attachPip(pipWin: Window): void {
    this.pipKeyCleanup?.();
    const onKey = (e: KeyboardEvent) => this.onKeyDown(e);
    pipWin.document.addEventListener("keydown", onKey);
    const onHide = () => {
      pipWin.document.removeEventListener("keydown", onKey);
      this.pipKeyCleanup = null;
      const unexpected = !this.closingPip;
      this.closingPip = false;
      this.patch({ pip: { ...this.snap.pip, window: null, closedUnexpectedly: unexpected } });
    };
    pipWin.addEventListener("pagehide", onHide, { once: true });
    this.pipKeyCleanup = () => {
      pipWin.document.removeEventListener("keydown", onKey);
      pipWin.removeEventListener("pagehide", onHide);
    };
    this.patch({ pip: { ...this.snap.pip, window: pipWin, closedUnexpectedly: false } });
  }

  /** Bring the panel back to the tab. */
  closePip(): void {
    const pipWin = this.snap.pip.window;
    if (!pipWin) return;
    this.closingPip = true;
    pipWin.close();
    try {
      this.deps?.win?.focus();
    } catch {
      // Focus is a nicety.
    }
  }

  dismissPipNote(): void {
    if (this.snap.pip.closedUnexpectedly) this.patch({ pip: { ...this.snap.pip, closedUnexpectedly: false } });
  }

  // Windows app

  setDesktopView(view: DesktopView): void {
    void this.bridge?.setView(view).then(
      (actual) => this.patch({ desktop: { ...this.snap.desktop, view: actual } }),
      () => undefined,
    );
  }

  setHotkey(preset: DesktopHotkeyPreset): void {
    void this.bridge?.setHotkey(preset).then(
      (hotkey) => this.patch({ desktop: { ...this.snap.desktop, hotkey } }),
      () => undefined,
    );
  }

  hideWindow(): void {
    void this.bridge?.hideWindow().catch(() => undefined);
  }

  private updateTitle(): void {
    const doc = this.deps?.win?.document;
    if (!doc) return;
    const title = this.snap.capture.state === "listening" ? `● ${this.baseTitle}` : this.baseTitle;
    if (doc.title !== title) doc.title = title;
  }

  private updateTray(): void {
    const bridge = this.bridge;
    if (!bridge) return;
    const capture = this.snap.capture;
    let problem: string | null = null;
    if (capture.state === "paused" && capture.reason === "source_lost") problem = sourceLostLabel(capture.source);
    else if (capture.state === "listening" && this.level.quiet) problem = quietHint(capture.source);
    const state: DesktopTrayState = { listening: capture.state === "listening", problem };
    const key = JSON.stringify(state);
    if (key === this.lastTray) return;
    this.lastTray = key;
    void bridge.setTrayState(state).catch(() => undefined);
  }

  /** Stops capture, drops the pipeline and every listener. For tests and page teardown. */
  dispose(): void {
    this.pipKeyCleanup?.();
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Keep tearing down.
      }
    }
    this.wake?.dispose();
    this.pipeline?.dispose();
    void this.engine?.stop().catch(() => undefined);
    this.listeners.clear();
    this.levelListeners.clear();
  }
}

let shared: SessionController | null = null;

/** The page's controller. Creating it has no side effects, setup runs on the first subscription. */
export function getController(): SessionController {
  if (!shared) shared = new SessionController();
  return shared;
}
