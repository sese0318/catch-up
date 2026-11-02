import { describe, expect, it } from "vitest";
import { CAPS, widthOf } from "../card/schema";
import {
  acceleratorLabel,
  clockOfIso,
  cutToWidthUnits,
  exportFileName,
  fitNameForm,
  formatMemory,
  formatRunDate,
  formatSeconds,
  namesWidth,
  secondsUntil,
} from "./format";

describe("format helpers", () => {
  it("writes memory as minutes and seconds", () => {
    expect(formatMemory(0)).toBe("0:00");
    expect(formatMemory(84.9)).toBe("1:24");
    expect(formatMemory(120)).toBe("2:00");
    expect(formatMemory(-3)).toBe("0:00");
  });

  it("keeps the listener's wall clock from a local ISO time", () => {
    expect(clockOfIso("2026-11-02T10:42:40.123-05:00")).toBe("10:42");
    expect(clockOfIso("2026-11-03T00:05:00.000+09:00")).toBe("00:05");
    expect(clockOfIso("nonsense")).toBe("");
  });

  it("formats seconds, run dates and countdowns", () => {
    expect(formatSeconds(2900)).toBe("2.9 s");
    expect(formatRunDate("2026-11-03")).toBe("Nov 3");
    expect(formatRunDate("2026-11-03T18:00:00Z")).toBe("Nov 3");
    expect(formatRunDate("Nov 3")).toBe("Nov 3");
    expect(secondsUntil(10_500, 10_000)).toBe(1);
    expect(secondsUntil(9_000, 10_000)).toBe(0);
  });

  it("cuts input at code points by width units", () => {
    expect(cutToWidthUnits("abcdef", 4)).toBe("abcd");
    expect(cutToWidthUnits("星佳さん", 5)).toBe("星佳");
    expect(cutToWidthUnits("😀😀", 3)).toBe("😀");
    expect(cutToWidthUnits("short", 60)).toBe("short");
  });

  it("caps name forms so the joined forms always fit the header", () => {
    const names = ["Seika", "セイカ", ""];
    const third = fitNameForm(names, 2, "星".repeat(40), CAPS.listenerNames);
    const joined = [...names.slice(0, 2), third];
    expect(namesWidth(joined)).toBeLessThanOrEqual(CAPS.listenerNames);
    expect(widthOf(third)).toBeGreaterThan(0);
    expect(fitNameForm(["", "", ""], 0, "Seika", CAPS.listenerNames)).toBe("Seika");
  });

  it("names exports and hotkeys the way people read them", () => {
    expect(exportFileName(new Date(2026, 10, 2, 10, 42))).toBe("catch-up-2026-11-02-1042.md");
    expect(acceleratorLabel("Control+Alt+C")).toBe("Ctrl+Alt+C");
    expect(acceleratorLabel("Control+Shift+Space")).toBe("Ctrl+Shift+Space");
    expect(acceleratorLabel(null)).toBe("");
  });
});
