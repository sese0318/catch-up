// Client contracts. The capture engine (src/lib/audio), the press pipeline (src/lib/press)
// and the Windows app bridge (desktop/preload.js) implement these. The UI only calls them.
// Browser only. Never touch window or navigator at import time.
import type { Card, CardLang, LiveRoute, Source, WindowSec } from "../card/schema";
import {
  LIMITS,
  type ErrorCode,
  type MockSpec,
  type ProviderFailure,
  type RoutePreference,
  type ServerTiming,
  type StageName,
} from "../protocol";

// Capture engine

export const WORKLET_URL = "/worklets/catchup-ring.js";

export type CaptureSourceKind = Source;

/** Where the sample's speaker path is muffled (lowpass and lower gain). The ring always gets clean audio. */
export interface MuffleWindow {
  startSec: number;
  endSec: number;
}

export type CaptureSourceSpec =
  | { kind: "mic"; deviceId?: string; noisyRoom?: boolean } // all browser processing off unless noisyRoom
  | { kind: "tab" } // getDisplayMedia, tab pane, tab audio
  | { kind: "system" } // Chrome Entire screen with system audio, or Windows app loopback
  | { kind: "sample"; clipId: string; url: string; muffle?: MuffleWindow; keyMomentSec?: number };

export const CAPTURE_ERROR_CODES = [
  "insecure_context",
  "unsupported",
  "permission_denied",
  "share_cancelled",
  "no_audio_in_share",
  "device_error",
  "sample_failed",
] as const;
export type CaptureErrorCode = (typeof CAPTURE_ERROR_CODES)[number];

/** start() rejects with this. The status moves to error with the same code. */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  constructor(code: CaptureErrorCode, message?: string) {
    super(message ?? code);
    this.name = "CaptureError";
    this.code = code;
  }
}

/**
 * Why capture is paused. Every paused state has zeroed the ring and every snapshot.
 * user is Pause, interrupted is a phone hiding the page, source_lost is a track that ended,
 * replaced is a new start() taking over, and sample_ended is a finished sample whose hold ran out
 * (LIMITS.snapshotHoldMs after it ended). A sample that just finished is still listening, see endedAt.
 */
export type PauseReason = "user" | "interrupted" | "source_lost" | "sample_ended" | "replaced";

/** Snapshot for useSyncExternalStore. A new object only when something changed. */
export type CaptureStatus =
  | { state: "idle" }
  | { state: "starting"; source: CaptureSourceKind }
  | {
      state: "listening";
      source: CaptureSourceKind;
      startedAt: number;
      // Set only when a sample clip finished playing (epoch ms). The ring stops filling and level
      // readings stop, but the clip stays in memory and a press still works, until a new start(),
      // pause(), or endedAt + LIMITS.snapshotHoldMs (then paused with reason sample_ended).
      endedAt?: number;
    }
  | { state: "paused"; source: CaptureSourceKind | null; reason: PauseReason } // memory and held clips are zeroed
  | { state: "error"; source: CaptureSourceKind; code: CaptureErrorCode };

/** About 10 per second while listening. */
export interface LevelReading {
  at: number; // epoch ms
  rms: number; // 0 to 1
  peak: number; // 0 to 1
  speech: boolean; // above the speech threshold
  memorySec: number; // seconds held since start, the last gap or the last clear, 0 to LIMITS.memorySec
  quiet: boolean; // no speech for LIMITS.quietHintMs
}

export type CaptureEvent =
  | { type: "track_ended" } // Stop sharing clicked or device unplugged. Status becomes paused, source_lost
  | { type: "interrupted" } // a phone hid the page. Status becomes paused, interrupted
  | { type: "gap" } // a discontinuity was marked, memory restarts from it
  | { type: "sample"; phase: "playing" | "ended"; currentSec: number; muffled: boolean; keyMomentPassed: boolean };

export interface CaptureSupport {
  secureContext: boolean;
  audioWorklet: boolean;
  mic: boolean;
  tab: boolean; // tab audio through getDisplayMedia (Chrome and Edge on desktop)
  system: boolean; // system audio (Windows Chrome or Edge, or the Windows app)
  desktopApp: boolean; // window.catchUpDesktop exists
  phone: boolean;
  nativeRate: boolean; // WebKit keeps the context at its native rate and resamples at press time
}

export interface CaptureEngineOptions {
  memorySec?: number; // default LIMITS.memorySec
  workletUrl?: string; // default WORKLET_URL
}

/** The last windowSec seconds of a snapshot, ready to POST. */
export interface ClipSlice {
  readonly wav: ArrayBuffer; // 16 kHz mono PCM16 WAV, peak-normalized
  readonly windowSec: WindowSec;
  readonly sentSec: number; // less than windowSec when memory was not full
  readonly bytes: number;
  readonly peak: number; // before normalization, 0 to 1
  readonly rms: number; // before normalization
  readonly silent: boolean; // local silence gate verdict, true means do not send
}

/** Up to LIMITS.memorySec seconds frozen at press time. Self-zeroes after LIMITS.snapshotHoldMs. */
export interface Snapshot {
  readonly id: string;
  readonly takenAt: number; // epoch ms
  readonly memorySec: number;
  readonly source: CaptureSourceKind;
  readonly gapCut: boolean; // a gap shortened it
  readonly released: boolean;
  slice(windowSec: WindowSec): Promise<ClipSlice>; // rejects once released
  release(): void; // zeroes the PCM now
}

export interface CaptureEngine {
  getStatus(): CaptureStatus;
  getSource(): CaptureSourceSpec | null;
  subscribe(listener: () => void): () => void; // status changes
  onLevel(listener: (reading: LevelReading) => void): () => void;
  onEvent(listener: (event: CaptureEvent) => void): () => void;
  /** Call synchronously inside the click or tap handler. Nothing is awaited before the browser prompt. */
  start(source: CaptureSourceSpec): Promise<void>;
  /** Stops every track so OS indicators go off, zeroes the ring and every snapshot. */
  pause(): Promise<void>;
  /** pause() plus closing the AudioContext. */
  stop(): Promise<void>;
  memorySeconds(): number;
  /** Freezes everything held, up to LIMITS.memorySec seconds. */
  snapshot(): Promise<Snapshot>;
}

// Press pipeline

/**
 * Read at press time from the UI's settings (localStorage) and session state. names and hint are
 * the raw inputs. The pipeline runs normalizeNames and normalizeHint (src/lib/protocol.ts) before
 * encodeMetaHeader, and reports any encode failure as error bad_request with sent false.
 */
export interface PressSettings {
  cardLang: CardLang;
  meetingLang: CardLang;
  windowSec: WindowSec;
  names: readonly string[]; // raw forms, the UI caps each input with widthOf
  hint: string; // raw text, empty string when there is none
  route: RoutePreference;
  mock?: MockSpec; // dev only, from ?mock=
  tz?: string; // IANA time zone
}

export type PressRequest =
  | { kind: "new"; pressedAt: number } // epoch ms of the keydown, pointerdown or hotkey event
  | { kind: "further_back" } // same snapshot, next window, replaces the latest card
  | { kind: "language"; cardLang: CardLang } // same clip in another card language, replaces the latest card
  | { kind: "send_anyway" } // sends the slice the silence gate held back
  | { kind: "retry"; route?: RoutePreference }; // after an error, optionally on the other route
export type PressKind = PressRequest["kind"];

export type PressEvent =
  | { type: "pressed"; pressId: string; kind: PressKind; pressedAt: number; stall: { text: string; lang: CardLang } }
  | { type: "sending"; pressId: string; windowSec: WindowSec; sentSec: number; bytes: number; partial: boolean }
  | { type: "silent"; pressId: string; windowSec: WindowSec; sentSec: number } // nothing was sent
  | { type: "stage"; pressId: string; name: StageName; elapsedMs: number }
  | { type: "still_working"; pressId: string; elapsedMs: number }
  | {
      type: "card";
      pressId: string;
      card: Card; // card.meta.sent says what left the device. A cached stand-in has cachedBecause set
      replaces: string | null; // id of the card this one replaces (Further back, language redo)
      server: ServerTiming | null; // null for cached cards
    }
  | {
      type: "error";
      pressId: string;
      code: ErrorCode; // aborted means the press ended without Esc or Cancel, for example dispose()
      retryable: boolean;
      sent: boolean; // whether audio or a transcript left the device for this press
      route?: LiveRoute;
      cause?: ProviderFailure;
      retryAfterSec?: number;
    }
  | { type: "cancelled"; pressId: string; sent: boolean } // Esc or Cancel only. The UI shows ERROR_COPY_EN.aborted
  | { type: "held"; until: number | null }; // the press snapshot is reusable until then, null once zeroed

export type PressRefusal = "busy" | "not_listening" | "warming_up" | "nothing_held";
export type PressResult = { accepted: true; pressId: string } | { accepted: false; reason: PressRefusal };

export interface PressPipeline {
  /** Never throws. Ignored while a press is in flight. */
  press(request: PressRequest): PressResult;
  /** Esc or Cancel. Aborts the request and emits cancelled, never an error event. */
  cancel(): void;
  isBusy(): boolean;
  heldUntil(): number | null;
  on(listener: (event: PressEvent) => void): () => void;
  /** Cancels, zeroes the held snapshot and drops listeners. */
  dispose(): void;
}

export interface PressDeps {
  engine: CaptureEngine;
  getSettings: () => PressSettings;
  sessionId: string; // newSessionId() once per page session
  fetchImpl?: typeof fetch;
  endpoint?: string; // default CARD_ENDPOINT
  now?: () => number;
}

/** Further back steps 30, 60, 120. Null when there is no longer window. */
export function nextWindow(windowSec: WindowSec): WindowSec | null {
  if (windowSec === 30) return 60;
  if (windowSec === 60) return 120;
  return null;
}

/** True while the ring holds too little audio to press (Collecting sound). */
export function isWarmingUp(memorySec: number): boolean {
  return memorySec < LIMITS.warmupSec;
}

// Windows app bridge (desktop/preload.js exposes it with contextBridge)

export const DESKTOP_BRIDGE_GLOBAL = "catchUpDesktop" as const;
export const DESKTOP_BRIDGE_VERSION = 1 as const;

/** Electron accelerators, tried in order when one is taken. */
export const DESKTOP_HOTKEY_PRESETS = ["Control+Alt+C", "Control+Shift+Space", "Control+Alt+Space"] as const;
export type DesktopHotkeyPreset = (typeof DESKTOP_HOTKEY_PRESETS)[number];

export interface DesktopHotkeyState {
  accelerator: DesktopHotkeyPreset | null; // null when no preset could be registered
  registered: boolean;
  error: string | null;
}

export type DesktopView = "compact" | "full"; // 360 x 480 non-focusable panel, or 480 x 760 Full view

/** Tray Pause and Resume. Tray Catch me up is a press and travels on DESKTOP_IPC.hotkey instead. */
export const DESKTOP_COMMANDS = ["pause", "resume"] as const;
export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

/** One press from the main process, the global hotkey or tray Catch me up. The page treats both the same. */
export interface DesktopPressPayload {
  at: number; // epoch ms of the key event or the tray click in main, used as pressedAt
  via: "hotkey" | "tray";
  accelerator: DesktopHotkeyPreset | null; // the live preset for a hotkey press, null for the tray
}

export interface DesktopTrayState {
  listening: boolean; // filled icon while listening, hollow when paused
  problem: string | null; // badge plus tooltip, for example "Stopped hearing system audio"
}

/** IPC channel names shared by desktop/main.js and desktop/preload.js. */
export const DESKTOP_IPC = {
  hotkey: "catchup:hotkey", // main to page, payload DesktopPressPayload (global hotkey and tray Catch me up)
  hotkeyChanged: "catchup:hotkey-changed", // main to page, payload DesktopHotkeyState, after any registration change
  command: "catchup:command", // main to page, payload DesktopCommand
  viewChanged: "catchup:view-changed", // main to page, payload DesktopView
  getView: "catchup:get-view",
  setView: "catchup:set-view",
  getHotkey: "catchup:get-hotkey",
  setHotkey: "catchup:set-hotkey",
  setTrayState: "catchup:set-tray-state",
  showPanel: "catchup:show-panel",
  copyText: "catchup:copy-text",
  hide: "catchup:hide",
} as const;

export interface CatchUpDesktopBridge {
  readonly isDesktop: true;
  readonly bridgeVersion: typeof DESKTOP_BRIDGE_VERSION;
  /** A press from main, the global hotkey or tray Catch me up. Returns unsubscribe. */
  onHotkey(callback: (payload: DesktopPressPayload) => void): () => void;
  /** Fires after startup registration, a preset fallback, setHotkey or a tray preset pick. */
  onHotkeyChange(callback: (state: DesktopHotkeyState) => void): () => void;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
  onViewChange(callback: (view: DesktopView) => void): () => void;
  getView(): Promise<DesktopView>;
  setView(view: DesktopView): Promise<DesktopView>;
  getHotkey(): Promise<DesktopHotkeyState>;
  setHotkey(accelerator: DesktopHotkeyPreset): Promise<DesktopHotkeyState>;
  setTrayState(state: DesktopTrayState): Promise<void>;
  /** Shows the panel inactive, or focused for keyboard and screen reader users. */
  showPanel(options?: { focus?: boolean }): Promise<void>;
  /** Clipboard through the main process, because the panel never takes focus. */
  copyText(text: string): Promise<boolean>;
  hideWindow(): Promise<void>;
}

declare global {
  interface Window {
    catchUpDesktop?: CatchUpDesktopBridge;
  }
}

/** The bridge inside the Windows app, null in a browser or during server rendering. */
export function getDesktopBridge(): CatchUpDesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.catchUpDesktop;
  return bridge && bridge.isDesktop === true ? bridge : null;
}
