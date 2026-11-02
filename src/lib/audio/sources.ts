// Request options for each source and the mapping of browser failures to capture error codes
// (browser-audio.md 1.2 to 1.6 and 2, electron-windows.md 1-2b). Pure, no DOM.
import type { CaptureErrorCode, CaptureSourceKind } from "./types";
import { CaptureError } from "./types";

/** Mic with every browser processing flag off. noisyRoom turns noise suppression on, nothing else. */
export function micConstraints(spec: { deviceId?: string; noisyRoom?: boolean }): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    channelCount: { ideal: 1 },
    echoCancellation: false,
    noiseSuppression: spec.noisyRoom === true,
    autoGainControl: false, // each clip is peak-normalized at press time instead
  };
  if (spec.deviceId) audio.deviceId = { exact: spec.deviceId };
  return { audio, video: false };
}

/** Members lib.dom does not know yet. Browsers ignore members they do not know. */
export interface DisplayCaptureOptions {
  video: Record<string, unknown>;
  audio: Record<string, unknown>;
  controller?: unknown;
  selfBrowserSurface: "exclude";
  preferCurrentTab: false;
  surfaceSwitching: "include";
  monitorTypeSurfaces: "include";
  systemAudio: "include";
  windowAudio: "system";
}

/**
 * Tab or system audio through getDisplayMedia. The video track is required by the spec and stays
 * live at 1 fps. restrictOwnAudio goes only to the Windows app, because in Chrome it would drop the
 * audio of every other Chrome tab on an Entire screen share.
 */
export function displayMediaOptions(
  kind: "tab" | "system",
  options: { restrictOwnAudio: boolean; controller?: unknown },
): DisplayCaptureOptions {
  const audio: Record<string, unknown> = {
    suppressLocalAudioPlayback: false, // true would mute the meeting for the user
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (options.restrictOwnAudio) audio.restrictOwnAudio = true;
  const out: DisplayCaptureOptions = {
    video: { displaySurface: kind === "tab" ? "browser" : "monitor", frameRate: { max: 1 }, width: { max: 640 } },
    audio,
    selfBrowserSurface: "exclude",
    preferCurrentTab: false,
    surfaceSwitching: "include",
    monitorTypeSurfaces: "include",
    systemAudio: "include",
    windowAudio: "system",
  };
  if (options.controller !== undefined) out.controller = options.controller;
  return out;
}

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "";
}

/** Maps a getUserMedia, getDisplayMedia, worklet or decode failure to the code the UI explains. */
export function captureErrorCode(error: unknown, kind: CaptureSourceKind, secureContext: boolean): CaptureErrorCode {
  if (error instanceof CaptureError) return error.code;
  if (!secureContext) return "insecure_context";
  if (kind === "sample") return "sample_failed";
  const display = kind !== "mic";
  switch (errorName(error)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "InvalidStateError": // no user gesture, start again from a click
      return display ? "share_cancelled" : "permission_denied";
    case "SecurityError":
      return "permission_denied";
    case "TypeError":
    case "NotSupportedError":
      return "unsupported";
    default:
      return "device_error"; // NotFoundError, NotReadableError, OverconstrainedError, AbortError
  }
}
