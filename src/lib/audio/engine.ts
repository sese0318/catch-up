// Capture engine (ux-spec 9 item 1, browser-audio.md 1 to 3 and 5). Audio lane. Browser only.
// One AudioContext (16 kHz, native rate on WebKit) feeding the catchup-ring AudioWorklet that
// holds the last 120 s. One source at a time. Mic with every browser processing flag off, tab or
// system audio through getDisplayMedia (video kept live at 1 fps, never enabled false), or a
// sample clip played muffled to the speakers and clean into the ring. Pause stops every track and
// zeroes the ring and all snapshots. Phones keep a Screen Wake Lock and pause on hide (interrupted).
// When a sample finishes, status stays listening with endedAt set and the ring keeps the clip, so
// a press still works, until a new start(), pause() or LIMITS.snapshotHoldMs later (paused with
// reason sample_ended, memory zeroed).
// The logic lives in capture.ts behind a CaptureEnv seam (env.ts), so it is tested with fakes.
import { CaptureEngineCore } from "./capture";
import { browserCaptureEnv } from "./env";
import { readBrowserSupport } from "./support";
import { getDesktopBridge, type CaptureEngine, type CaptureEngineOptions, type CaptureSupport } from "./types";

/** Creates an idle engine. Nothing is requested from the browser until start(). */
export function createCaptureEngine(options?: CaptureEngineOptions): CaptureEngine {
  return new CaptureEngineCore(browserCaptureEnv, options);
}

/** Feature check for the source step. Safe during server rendering (returns all false). */
export function getCaptureSupport(): CaptureSupport {
  return readBrowserSupport(getDesktopBridge() !== null);
}
