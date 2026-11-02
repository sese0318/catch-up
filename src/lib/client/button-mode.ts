// The big button is the one primary action in every state (ux-spec 4 The Panel, 7 States).
// Start listening (or Resume, Reconnect, Try again), Collecting sound, Catch up, or Cancel.
import { isWarmingUp, type CaptureStatus } from "../audio/types";
import { LIMITS } from "../protocol";
import { UI } from "./copy";
import type { RequestView } from "./session-state";
import type { LiveSource } from "./settings";

export type ButtonMode =
  | { kind: "cancel" }
  | { kind: "catch" }
  | { kind: "warming"; secondsLeft: number }
  | { kind: "starting" }
  | { kind: "start"; label: string; action: "start" | "resume" };

const START: ButtonMode = { kind: "start", label: UI.startListening, action: "start" };

export function buttonMode(input: {
  request: RequestView;
  capture: CaptureStatus;
  memorySec: number;
  lastLiveSource: LiveSource | null;
}): ButtonMode {
  if (input.request.phase === "busy") return { kind: "cancel" };
  const capture = input.capture;
  switch (capture.state) {
    case "listening":
      // A finished sample keeps its clip in memory, so it can be pressed right away.
      if (capture.endedAt === undefined && isWarmingUp(input.memorySec)) {
        return { kind: "warming", secondsLeft: Math.max(1, Math.ceil(LIMITS.warmupSec - input.memorySec)) };
      }
      return { kind: "catch" };
    case "starting":
      return { kind: "starting" };
    case "paused":
      if (capture.source === "sample" || capture.source === null || !input.lastLiveSource) return START;
      if (capture.reason === "source_lost") return { kind: "start", label: UI.reconnect, action: "resume" };
      if (capture.reason === "user" || capture.reason === "interrupted") {
        return { kind: "start", label: UI.resume, action: "resume" };
      }
      return START;
    case "error":
      if (capture.source === "sample") return START;
      if (capture.code === "no_audio_in_share") return { kind: "start", label: UI.chooseAgain, action: "start" };
      if (capture.code === "permission_denied" || capture.code === "share_cancelled" || capture.code === "device_error") {
        return { kind: "start", label: UI.tryAgain, action: "start" };
      }
      return START;
    case "idle":
      return START;
  }
}
