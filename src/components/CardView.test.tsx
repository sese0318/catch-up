// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/card/schema";
import { makeCard } from "@/lib/client/test-helpers";
import { CardView } from "./CardView";

vi.mock("@/lib/audio/engine", () => ({
  createCaptureEngine: () => {
    throw new Error("not in this test");
  },
  getCaptureSupport: () => {
    throw new Error("not in this test");
  },
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline in tests"))),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function show(card: Card, interactive = false): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<CardView card={card} interactive={interactive} />));
  return container;
}

describe("card variants", () => {
  it("labels a saved result with its live route and run date", async () => {
    const el = await show(
      makeCard({
        meta: { route: "cached", cachedFrom: "open_weights", cachedRunAt: "2026-11-03", cachedBecause: "live_off" },
      }),
    );
    expect(el.querySelector(".cu-card-badges")?.textContent).toBe("Saved result from Muse Spark Open, run Nov 3");
  });

  it("marks mock cards with the striped MOCK chip", async () => {
    const el = await show(makeCard({ meta: { route: "mock", model: "mock" } }));
    expect(el.querySelector(".cu-badge-mock")?.textContent).toBe("MOCK");
  });

  it("hides the body when no one could be heard", async () => {
    const el = await show(makeCard({ heard: "none", ask: { to: "none" }, say: undefined, facts: [] }), true);
    expect(el.querySelector(".cu-no-speech")?.textContent).toContain("Couldn't make out any speech");
    expect(el.querySelector(".cu-ask, .cu-say, .cu-facts")).toBeNull();
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Check source")).toBe(true);
  });

  it("shows raw text for an Unformatted card, tagged", async () => {
    const el = await show(
      makeCard({
        heard: "partial",
        ask: { to: "none" },
        say: undefined,
        facts: [],
        summary: ["{ not json"],
        meta: { unformatted: true },
      }),
    );
    expect(el.querySelector(".cu-badge-warn")?.textContent).toBe("Unformatted");
    expect(el.querySelector(".cu-unformatted-text")?.textContent).toBe("{ not json");
    expect(el.querySelector(".cu-ask-none")).toBeNull();
  });

  it("tags Chinese as zh-Hans and keeps names in their own script", async () => {
    const el = await show(
      makeCard({
        ask: { to: "room", text: "谁来做今天的会议记录？" },
        say: { text: "确认一下，是今天的会议记录吗？", lang: "zh" },
        summary: ["有人问大家谁来做记录。"],
        facts: [{ kind: "name", text: "王老师" }, { kind: "date", text: "下周三", note: "11月11日" }],
        quote: "谁来做今天的会议记录？",
        meta: { cardLang: "zh" },
      }),
    );
    expect(el.querySelector(".cu-ask-neutral")).not.toBeNull();
    expect(el.querySelector(".cu-ask-label")?.getAttribute("lang")).toBe("zh-Hans");
    expect(el.querySelector(".cu-ask-label")?.textContent).toContain("在问大家");
    expect(el.querySelector(".cu-say-text")?.getAttribute("lang")).toBe("zh-Hans");
    expect(el.querySelector(".cu-say-label")?.textContent).toBe("这样确认");
    expect(el.querySelector(".cu-fact-text")?.getAttribute("lang")).toBe("zh-Hans");
    expect(el.querySelector(".cu-say-gloss")).toBeNull();
  });

  it("opens What they said with the quote and the Route A transcript", async () => {
    const el = await show(
      makeCard({ meta: { route: "meta_api", model: "muse-voice-transcribe-1.0 + muse-spark-1.3", transcript: "So Seika, does Thursday work?" } }),
    );
    const toggle = el.querySelector<HTMLButtonElement>(".cu-evidence .cu-disclosure");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector(".cu-quote")?.getAttribute("lang")).toBe("en");
    expect(el.querySelector(".cu-transcript")?.textContent).toBe("So Seika, does Thursday work?");
  });
});
