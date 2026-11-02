import { describe, expect, it } from "vitest";
import { createPressGuards } from "./guards";

const T0 = Date.UTC(2026, 10, 3, 23, 30, 0); // 23:30 UTC, half an hour before the day rolls over
const MIN = 60_000;

describe("press guards", () => {
  it("lets presses back in as they leave the one-hour window", () => {
    const guards = createPressGuards();
    guards.count("a", T0, 2);
    guards.count("a", T0 + 10 * MIN, 2);
    expect(guards.checkHourly("a", T0 + 20 * MIN, 2)).toEqual({ ok: false, retryAfterSec: 40 * 60 });
    expect(guards.checkHourly("b", T0 + 20 * MIN, 2)).toEqual({ ok: true });
    expect(guards.checkHourly("a", T0 + 60 * MIN, 2)).toEqual({ ok: true });
  });

  it("does not track clients when the hourly limit is off", () => {
    const guards = createPressGuards();
    for (let i = 0; i < 50; i++) guards.count("a", T0, 0);
    expect(guards.checkHourly("a", T0, 0)).toEqual({ ok: true });
    expect(guards.checkHourly("a", T0, 1)).toEqual({ ok: true });
  });

  it("counts every live press toward the daily cap and resets at UTC midnight", () => {
    const guards = createPressGuards();
    guards.count("a", T0, 0);
    guards.count("b", T0 + MIN, 0);
    expect(guards.dailyCapReached(T0 + 2 * MIN, 2)).toBe(true);
    expect(guards.dailyCapReached(T0 + 2 * MIN, 3)).toBe(false);
    expect(guards.dailyCapReached(T0 + 31 * MIN, 2)).toBe(false);
  });

  it("starts clean after reset", () => {
    const guards = createPressGuards();
    guards.count("a", T0, 1);
    expect(guards.checkHourly("a", T0, 1).ok).toBe(false);
    guards.reset();
    expect(guards.checkHourly("a", T0, 1).ok).toBe(true);
    expect(guards.dailyCapReached(T0, 1)).toBe(false);
  });
});
