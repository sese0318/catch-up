import { describe, expect, it } from "vitest";
import { eventEpochMs, isCatchUpCombo, isComposing, isEscape, type KeyLike } from "./hotkey";

const key = (patch: Partial<KeyLike>): KeyLike => ({
  key: "c",
  code: "KeyC",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...patch,
});

describe("in-page keys", () => {
  it("presses on Ctrl+Alt+C and the two fallbacks", () => {
    expect(isCatchUpCombo(key({ ctrlKey: true, altKey: true }))).toBe(true);
    expect(isCatchUpCombo(key({ key: " ", code: "Space", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isCatchUpCombo(key({ key: " ", code: "Space", ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("reads the key when an input tool sends no code", () => {
    expect(isCatchUpCombo(key({ code: "", ctrlKey: true, altKey: true }))).toBe(true);
    expect(isCatchUpCombo(key({ key: " ", code: "", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isCatchUpCombo(key({ key: "x", code: "", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isCatchUpCombo(key({ key: "c", code: "KeyX", ctrlKey: true, altKey: true }))).toBe(false); // code wins when present
  });

  it("never fires on a single letter or other combos", () => {
    expect(isCatchUpCombo(key({}))).toBe(false);
    expect(isCatchUpCombo(key({ ctrlKey: true }))).toBe(false);
    expect(isCatchUpCombo(key({ altKey: true }))).toBe(false);
    expect(isCatchUpCombo(key({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(isCatchUpCombo(key({ ctrlKey: true, altKey: true, metaKey: true }))).toBe(false);
    expect(isCatchUpCombo(key({ key: " ", code: "Space" }))).toBe(false);
    expect(isCatchUpCombo(key({ key: " ", code: "Space", ctrlKey: true }))).toBe(false);
  });

  it("skips IME composition and AltGr layouts", () => {
    expect(isCatchUpCombo(key({ ctrlKey: true, altKey: true, isComposing: true }))).toBe(false);
    expect(isCatchUpCombo(key({ ctrlKey: true, altKey: true, keyCode: 229 }))).toBe(false);
    expect(isComposing(key({ keyCode: 229 }))).toBe(true);
    const altGr = key({ ctrlKey: true, altKey: true, getModifierState: (k) => k === "AltGraph" });
    expect(isCatchUpCombo(altGr)).toBe(false);
  });

  it("knows Esc, but not while composing", () => {
    expect(isEscape(key({ key: "Escape", code: "Escape" }))).toBe(true);
    expect(isEscape(key({ key: "Escape", code: "Escape", isComposing: true }))).toBe(false);
  });

  it("dates a press from the event, falling back to the wall clock", () => {
    const now = () => 1_000_000;
    expect(eventEpochMs({ timeStamp: 0 }, now)).toBe(1_000_000);
    const at = eventEpochMs({ timeStamp: 10 }, () => performance.timeOrigin + 12);
    expect(Math.abs(at - (performance.timeOrigin + 10))).toBeLessThan(2);
  });
});
