// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PressEvent } from "@/lib/audio/types";
import { makeCard } from "@/lib/client/test-helpers";

const fakes = vi.hoisted(() => {
  type Listener = () => void;
  const subs = new Set<Listener>();
  const levels = new Set<(r: unknown) => void>();
  const pressListeners = new Set<(e: unknown) => void>();
  let status: Record<string, unknown> = { state: "idle" };
  let source: unknown = null;
  const engine = {
    getStatus: () => status,
    getSource: () => source,
    subscribe: (l: Listener) => {
      subs.add(l);
      return () => void subs.delete(l);
    },
    onLevel: (l: (r: unknown) => void) => {
      levels.add(l);
      return () => void levels.delete(l);
    },
    onEvent: () => () => undefined,
    start: vi.fn((spec: { kind: string }) => {
      source = spec;
      status = { state: "listening", source: spec.kind, startedAt: 1 };
      subs.forEach((f) => f());
      return Promise.resolve();
    }),
    pause: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    memorySeconds: () => 10,
    snapshot: vi.fn(),
    level(memorySec: number) {
      levels.forEach((f) => f({ at: Date.now(), rms: 0.1, peak: 0.3, speech: true, memorySec, quiet: false }));
    },
  };
  const pipeline = {
    press: vi.fn(() => ({ accepted: true, pressId: "p1" })),
    cancel: vi.fn(),
    isBusy: () => false,
    heldUntil: () => null,
    on: (l: (e: unknown) => void) => {
      pressListeners.add(l);
      return () => void pressListeners.delete(l);
    },
    dispose: vi.fn(),
    emit(e: unknown) {
      pressListeners.forEach((f) => f(e));
    },
  };
  const support = {
    secureContext: true,
    audioWorklet: true,
    mic: true,
    tab: true,
    system: true,
    desktopApp: false,
    phone: false,
    nativeRate: false,
  };
  const clip = {
    id: "ask-by-name",
    title: "An English ask by name",
    blurb: "A teammate asks you to pick a demo day.",
    url: "/samples/ask-by-name.mp3",
    durationSec: 24,
    spokenLangs: ["en"],
    muffle: { startSec: 10, endSec: 14 },
    keyMomentSec: 13,
    consent: "written",
    cached: {},
  };
  return { engine, pipeline, support, clip };
});

vi.mock("@/lib/audio/engine", () => ({
  createCaptureEngine: () => fakes.engine,
  getCaptureSupport: () => fakes.support,
}));
vi.mock("@/lib/press/press", () => ({
  createPressPipeline: () => fakes.pipeline,
  newSessionId: () => "session-test-1234",
}));
vi.mock("@/lib/samples/catalog", () => ({
  SAMPLE_CLIPS: [fakes.clip],
  DEV_SAMPLE_CLIPS: [],
  listSampleClips: () => [fakes.clip],
  getSampleClip: () => fakes.clip,
  getCachedCard: () => null,
}));

let container: HTMLDivElement;
let root: Root;

const q = <T extends Element = HTMLElement>(selector: string) => container.querySelector<T & Element>(selector);
const byText = (selector: string, text: string) =>
  [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.includes(text)) ?? null;
const emit = (event: PressEvent) => act(() => fakes.pipeline.emit(event));

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline in tests"))),
  );
  const { default: CatchUpApp } = await import("./CatchUpApp");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<CatchUpApp />);
  });
});

afterAll(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Catch Up page", () => {
  it("opens as the product, with samples and no permission prompt", () => {
    expect(fakes.engine.start).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Try a sample conversation");
    expect(container.textContent).toContain("An English ask by name");
    expect(container.textContent).toContain("Built with Muse Spark Open");
    expect(container.textContent).toContain("What should Catch Up hear?");
    const big = q<HTMLButtonElement>(".cu-big");
    expect(big?.textContent).toContain("Start listening");
    expect(big?.getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("Tick People here know first.");
  });

  it("shows the heads-up line in the meeting language with Copy for chat", () => {
    const line = q(".cu-heads-up");
    expect(line?.getAttribute("lang")).toBe("en");
    expect(line?.textContent).toContain("Only when I tap, it sends the last 30 seconds");
    expect(byText("button", "Copy for chat")).not.toBeNull();
  });

  it("starts listening after the tick and the one-time setup, inside the click", async () => {
    const consent = q<HTMLInputElement>("#cu-consent");
    await act(async () => consent?.click());
    expect(consent?.checked).toBe(true);
    const big = q<HTMLButtonElement>(".cu-big");
    expect(big?.getAttribute("aria-disabled")).toBeNull();

    await act(async () => big?.click());
    expect(fakes.engine.start).not.toHaveBeenCalled(); // setup comes first, once per device
    const continueButton = byText("dialog button", "Continue");
    expect(continueButton).not.toBeNull();
    expect(byText("dialog", "Catch Up is for people 18 and over.")).not.toBeNull();

    await act(async () => continueButton?.click());
    expect(fakes.engine.start).toHaveBeenCalledTimes(1);
    expect(fakes.engine.start).toHaveBeenCalledWith({ kind: "mic" });
    expect(q(".cu-status-text")?.textContent).toBe("Listening");
    expect(q(".cu-source-chip")?.textContent).toBe("Microphone");
    expect(q(".cu-source-chip")?.getAttribute("aria-label")).toBe("Microphone, change source");
    expect(document.title.startsWith("● ")).toBe(true);
  });

  it("collects sound first, then presses with Catch up and Ctrl+Alt+C", async () => {
    const big = q<HTMLButtonElement>(".cu-big");
    expect(big?.textContent).toContain("Collecting sound");
    await act(async () => fakes.engine.level(12));
    expect(big?.textContent).toContain("Catch up");
    expect(big?.getAttribute("aria-label")).toBe("Catch up, send the last 30 seconds");
    expect(big?.getAttribute("aria-keyshortcuts")).toBe("Control+Alt+C");

    await act(async () => big?.click());
    expect(fakes.pipeline.press).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "new" }));

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, altKey: true, cancelable: true }));
    });
    expect(fakes.pipeline.press).toHaveBeenCalledTimes(2);
  });

  it("fills the wait with the stall line, then shows the card in panic order", async () => {
    await emit({
      type: "pressed",
      pressId: "p1",
      kind: "new",
      pressedAt: Date.now(),
      stall: { text: "少し考えさせてください。", lang: "ja" },
    });
    const stall = q(".cu-stall-line");
    expect(stall?.textContent).toBe("少し考えさせてください。");
    expect(stall?.getAttribute("lang")).toBe("ja");
    expect(q(".cu-big")?.textContent).toContain("Cancel");

    await emit({ type: "sending", pressId: "p1", windowSec: 30, sentSec: 30, bytes: 960_044, partial: false });
    expect(q(".cu-membar-label")?.textContent).toBe("Sending 30 s");
    await emit({ type: "stage", pressId: "p1", name: "writing", elapsedMs: 2_000 });
    expect(q(".cu-stage")?.textContent).toContain("Writing your card");

    const card = makeCard({
      say: { text: "Just to check, Thursday for the demo, or push to Monday?", lang: "en", gloss: "木曜か月曜かの確認" },
      summary: ["デモの日を木曜か月曜で決めてほしいと聞かれました。"],
      facts: [
        { kind: "name", text: "Siobhan", note: "シボーン" },
        { kind: "number", text: "15%", note: "50%かも", unsure: true },
      ],
      meta: { cardLang: "ja" },
    });
    await emit({ type: "card", pressId: "p1", card, replaces: null, server: null });

    const article = q("article.cu-card");
    expect(article).not.toBeNull();
    const order = [...(article?.querySelectorAll(".cu-ask, .cu-say, .cu-summary, .cu-facts, .cu-receipt") ?? [])].map(
      (el) => el.className.split(" ")[0],
    );
    expect(order).toEqual(["cu-ask", "cu-say", "cu-summary", "cu-facts", "cu-receipt"]);
    expect(q(".cu-ask-label")?.getAttribute("lang")).toBe("ja");
    expect(q(".cu-ask-label")?.textContent).toContain("あなたへの質問");
    expect(q(".cu-say-text")?.getAttribute("lang")).toBe("en");
    expect(q(".cu-ai-tag")?.textContent).toContain("AIの提案");
    expect(q(".cu-say-gloss")?.textContent).toContain("木曜か月曜かの確認");
    expect(byText("button", "Copy line")).not.toBeNull();
    const unsure = q(".cu-fact[data-unsure]");
    expect(unsure?.textContent).toContain("要確認");
    expect(q(".cu-fact-text")?.getAttribute("lang")).toBe("en");
    expect(q(".cu-receipt")?.textContent).toMatch(/saved nothing/i);

    const assertive = q('[aria-live="assertive"]');
    expect(assertive?.textContent).toContain("あなたへの質問");
    expect(assertive?.textContent).toContain("Just to check, Thursday");
    expect(q('[aria-live="polite"]')?.textContent).toBe("");
    expect(q(".cu-big")?.textContent).toContain("Catch up");
  });

  it("keeps the card in this session's history and closes it with Esc", async () => {
    expect(container.textContent).toContain("This session (1)");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", cancelable: true }));
    });
    expect(q("article.cu-card")).toBeNull();
    expect(container.textContent).toContain("This session (1)");
  });

  it("says what happened and whether anything left on an error", async () => {
    await emit({ type: "pressed", pressId: "p2", kind: "new", pressedAt: Date.now(), stall: { text: "x", lang: "en" } });
    await emit({ type: "error", pressId: "p2", code: "provider_error", retryable: true, sent: true, route: "open_weights" });
    expect(container.textContent).toContain("The model service returned an error. Catch Up saved nothing.");
    expect(container.textContent).toContain("The clip left this device for this request only.");
    const retry = byText(".cu-notice button", "Retry");
    await act(async () => retry?.click());
    expect(fakes.pipeline.press).toHaveBeenLastCalledWith({ kind: "retry" });
  });
});
