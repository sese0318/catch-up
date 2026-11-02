import { describe, expect, it } from "vitest";
import { buttonMode } from "./button-mode";
import { UI } from "./copy";
import type { RequestView } from "./session-state";

const idle: RequestView = { phase: "idle" };

describe("big button", () => {
  it("starts listening when idle", () => {
    expect(buttonMode({ request: idle, capture: { state: "idle" }, memorySec: 0, lastLiveSource: null })).toEqual({
      kind: "start",
      label: UI.startListening,
      action: "start",
    });
  });

  it("collects sound for the first 5 seconds, then catches up", () => {
    const capture = { state: "listening", source: "mic", startedAt: 1 } as const;
    expect(buttonMode({ request: idle, capture, memorySec: 2.2, lastLiveSource: "mic" })).toEqual({
      kind: "warming",
      secondsLeft: 3,
    });
    expect(buttonMode({ request: idle, capture, memorySec: 5, lastLiveSource: "mic" })).toEqual({ kind: "catch" });
  });

  it("lets a finished sample be pressed even with little memory", () => {
    const capture = { state: "listening", source: "sample", startedAt: 1, endedAt: 2 } as const;
    expect(buttonMode({ request: idle, capture, memorySec: 0, lastLiveSource: null })).toEqual({ kind: "catch" });
  });

  it("becomes Cancel while a press is in flight", () => {
    const busy: RequestView = {
      phase: "busy",
      pressId: "p1",
      kind: "new",
      pressedAt: 1,
      stall: { text: "x", lang: "en" },
      step: "sending",
      windowSec: 30,
      sentSec: 30,
      bytes: 960_044,
      partial: false,
      stillWorking: false,
      fallback: false,
    };
    expect(buttonMode({ request: busy, capture: { state: "idle" }, memorySec: 0, lastLiveSource: null })).toEqual({
      kind: "cancel",
    });
  });

  it("offers Resume, Reconnect and Choose again with the right action", () => {
    const paused = (reason: "user" | "interrupted" | "source_lost" | "sample_ended") =>
      buttonMode({ request: idle, capture: { state: "paused", source: "tab", reason }, memorySec: 0, lastLiveSource: "tab" });
    expect(paused("user")).toMatchObject({ label: UI.resume, action: "resume" });
    expect(paused("interrupted")).toMatchObject({ label: UI.resume, action: "resume" });
    expect(paused("source_lost")).toMatchObject({ label: UI.reconnect, action: "resume" });
    expect(paused("sample_ended")).toMatchObject({ label: UI.startListening, action: "start" });
    expect(
      buttonMode({
        request: idle,
        capture: { state: "error", source: "tab", code: "no_audio_in_share" },
        memorySec: 0,
        lastLiveSource: "tab",
      }),
    ).toMatchObject({ label: UI.chooseAgain });
    expect(
      buttonMode({
        request: idle,
        capture: { state: "error", source: "mic", code: "permission_denied" },
        memorySec: 0,
        lastLiveSource: "mic",
      }),
    ).toMatchObject({ label: UI.tryAgain });
  });
});
