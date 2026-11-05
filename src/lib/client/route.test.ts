import { describe, expect, it } from "vitest";
import { LIMITS, type HealthResponse } from "../protocol";
import { otherRoute, parseHealth, parseMockParam, planRoute, type HealthView } from "./route";

function health(patch: { mock?: boolean; b?: boolean; a?: boolean; live?: boolean } = {}): HealthView {
  const data: HealthResponse = {
    ok: true,
    v: 1,
    live: patch.live ?? true,
    paused: null,
    defaultRoute: "auto",
    mock: patch.mock ?? false,
    routes: {
      open_weights: { configured: patch.b ?? true, model: "meta-models/muse-spark-open-1026", provider: "Baseten" },
      meta_api: { configured: patch.a ?? true, model: "muse-voice-transcribe-1.0 + muse-spark-1.3", provider: "Meta" },
    },
    limits: { maxBodyBytes: 4_400_000, maxClipSec: 125, perHour: 30, hardCapMs: LIMITS.hardCapMs },
  };
  return { state: "ok", data };
}

describe("?mock= param", () => {
  it("reads modes, fixtures and the shorthand", () => {
    expect(parseMockParam("")).toBeNull();
    expect(parseMockParam("?mock=1")).toEqual({ mode: "ok" });
    expect(parseMockParam("?mock=slow")).toEqual({ mode: "slow" });
    expect(parseMockParam("?mock=error")).toEqual({ mode: "error" });
    expect(parseMockParam("?mock=badjson")).toEqual({ mode: "badjson" });
    expect(parseMockParam("?mock=ok&fixture=you")).toEqual({ mode: "ok", fixture: "you" });
    expect(parseMockParam("?mock=unsure_number")).toEqual({ mode: "ok", fixture: "unsure_number" });
    expect(parseMockParam("?mock=0")).toBeNull();
    expect(parseMockParam("?mock=whatever&fixture=nope")).toEqual({ mode: "ok" });
  });
});

describe("route plan", () => {
  it("uses Advanced settings when live routes exist", () => {
    expect(planRoute("auto", health(), null)).toEqual({ route: "auto", mockReason: null });
    expect(planRoute("meta_api", health(), null).route).toBe("meta_api");
  });

  it("uses mock for ?mock= only where the server allows it", () => {
    expect(planRoute("auto", health({ mock: true }), { mode: "slow" })).toEqual({
      route: "mock",
      mock: { mode: "slow" },
      mockReason: "param",
    });
    expect(planRoute("auto", health({ mock: false }), { mode: "ok" }).route).toBe("auto");
    expect(planRoute("auto", { state: "loading" }, { mode: "ok" }).route).toBe("mock");
  });

  it("falls back to mock in dev when no live route has a key", () => {
    expect(planRoute("auto", health({ mock: true, a: false, b: false }), null)).toEqual({
      route: "mock",
      mock: { mode: "ok" },
      mockReason: "no_live",
    });
    expect(planRoute("auto", health({ mock: false, a: false, b: false }), null).route).toBe("auto");
  });

  it("offers the other route only when both are set up", () => {
    const plan = planRoute("auto", health(), null);
    expect(otherRoute("open_weights", plan, health())).toBe("meta_api");
    expect(otherRoute("meta_api", plan, health())).toBe("open_weights");
    expect(otherRoute(undefined, plan, health())).toBe("meta_api");
    expect(otherRoute("open_weights", plan, health({ a: false }))).toBeNull();
    expect(otherRoute("open_weights", { route: "mock", mockReason: "param" }, health())).toBeNull();
  });

  it("never switches a pinned route, so Open weights only never reaches the Meta Model API", () => {
    expect(otherRoute("open_weights", planRoute("open_weights", health(), null), health())).toBeNull();
    expect(otherRoute(undefined, planRoute("open_weights", health(), null), health())).toBeNull();
    const pinnedServer = health();
    if (pinnedServer.state === "ok") pinnedServer.data.defaultRoute = "open_weights";
    expect(otherRoute("open_weights", planRoute("auto", pinnedServer, null), pinnedServer)).toBeNull();
    expect(otherRoute("meta_api", planRoute("meta_api", health(), null), health())).toBeNull();
    expect(otherRoute("open_weights", planRoute("auto", { state: "loading" }, null), { state: "loading" })).toBeNull();
  });

  it("parses health and refuses anything else", () => {
    const h = health();
    expect(h.state === "ok" && parseHealth(h.data)).toBeTruthy();
    expect(parseHealth({ ok: true })).toBeNull();
    expect(parseHealth(null)).toBeNull();
  });
});
