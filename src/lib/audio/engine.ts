// Capture engine (ux-spec 9 item 1, browser-audio.md 1 to 3 and 5). Audio lane. Browser only.
// One AudioContext (16 kHz, native rate on WebKit) feeding the catchup-ring AudioWorklet that
// holds the last 120 s. One source at a time. Mic with every browser processing flag off, tab or
// system audio through getDisplayMedia (video kept live at 1 fps, never enabled false), or a
// sample clip played muffled to the speakers and clean into the ring. Pause stops every track and
// zeroes the ring and all snapshots. Phones keep a Screen Wake Lock and pause on hide (interrupted).
import type { CaptureEngine, CaptureEngineOptions, CaptureSupport } from "./types";

/** Creates an idle engine. Nothing is requested from the browser until start(). */
export function createCaptureEngine(options?: CaptureEngineOptions): CaptureEngine {
  void options;
  throw new Error("not implemented");
}

/** Feature check for the source step. Safe during server rendering (returns all false). */
export function getCaptureSupport(): CaptureSupport {
  throw new Error("not implemented");
}
