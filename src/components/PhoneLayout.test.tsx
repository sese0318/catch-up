// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PressEvent } from "@/lib/audio/types";
import { makeCard } from "@/lib/client/test-helpers";

// The phone layout (480 px and narrower). The fixed thumb zone holds the big button alone, and the
// tick, the window chips, Pause and Earlier scroll with the content right above it.

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
    tab: false,
    system: false,
    desktopApp: false,
    phone: true,
    nativeRate: false,
  };
  return { engine, pipeline, support };
});

vi.mock("@/lib/audio/engine", () => ({
  createCaptureEngine: () => fakes.engine,
  getCaptureSupport: () => fakes.support,
}));
vi.mock("@/lib/press/press", () => ({
  createPressPipeline: () => fakes.pipeline,
  newSessionId: () => "session-test-phone",
}));
vi.mock("@/lib/samples/catalog", () => ({
  SAMPLE_CLIPS: [],
  DEV_SAMPLE_CLIPS: [],
  listSampleClips: () => [],
  getSampleClip: () => null,
  getCachedCard: () => null,
}));

let container: HTMLDivElement;
let root: Root;

const q = <T extends Element = HTMLElement>(selector: string) => container.querySelector<T & Element>(selector);
const byText = (selector: string, text: string) =>
  [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.includes(text)) ?? null;
const emit = (event: PressEvent) => act(() => fakes.pipeline.emit(event));
const band = () => q('.cu-panel[data-surface="phone"] .cu-action-bar');
const tools = () => q('.cu-panel[data-surface="phone"] .cu-phone-tools');
const controlsIn = (el: Element | null) => [...(el?.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]") ?? [])];

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 480px)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
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
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("phone layout", () => {
  it("keeps only the big button in the fixed thumb zone, with the tick and the chips right above it", () => {
    expect(q(".cu-app")?.dataset.layout).toBe("phone");
    const controls = controlsIn(band());
    expect(controls).toHaveLength(1);
    expect(controls[0]?.classList.contains("cu-big")).toBe(true);

    const above = tools();
    expect(above?.querySelector("#cu-consent")).not.toBeNull();
    expect(byText(".cu-phone-tools button", "Show heads-up")).not.toBeNull();
    expect(above?.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    // Same reading and tab order as before, just out of the fixed zone.
    expect((above?.compareDocumentPosition(band() as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says why Start listening waits inside the button, as its description", () => {
    const big = q<HTMLButtonElement>(".cu-big");
    expect(big?.getAttribute("aria-disabled")).toBe("true");
    expect(big?.getAttribute("aria-label")).toBe("Start listening");
    const reasonId = big?.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId ?? "");
    expect(reason?.textContent).toBe("Tick People here know first.");
    expect(big?.contains(reason ?? null)).toBe(true);
    expect(q(".cu-big-reason")).toBeNull();
  });

  it("drops the reason once ticked and names the button by what it shows", async () => {
    const consent = q<HTMLInputElement>("#cu-consent");
    await act(async () => consent?.click());
    expect(consent?.checked).toBe(true);
    const big = q<HTMLButtonElement>(".cu-big");
    expect(big?.getAttribute("aria-disabled")).toBeNull();
    expect(big?.getAttribute("aria-describedby")).toBeNull();
    expect(big?.getAttribute("aria-label")).toBeNull();
    expect(big?.textContent).toContain("Start listening");
    expect(big?.textContent).toContain("People in the room");
  });

  it("moves Pause and Earlier out of the fixed zone once listening and a card is in", async () => {
    await act(async () => q<HTMLButtonElement>(".cu-big")?.click());
    const continueButton = byText("dialog button", "Continue");
    expect(continueButton).not.toBeNull();
    await act(async () => continueButton?.click());
    expect(fakes.engine.start).toHaveBeenCalledWith({ kind: "mic" });
    expect(q("#cu-consent")).toBeNull();
    expect(byText(".cu-phone-tools button", "Pause")).not.toBeNull();

    await act(async () => fakes.engine.level(12));
    const big = q<HTMLButtonElement>(".cu-big");
    expect(big?.textContent).toContain("Catch up");
    await act(async () => big?.click());
    const at = Date.now();
    await emit({ type: "pressed", pressId: "p1", kind: "new", pressedAt: at, startedAt: at, stall: { text: "One moment.", lang: "en" } });
    await emit({ type: "card", pressId: "p1", card: makeCard(), replaces: null, server: null });

    expect(q("article.cu-card")).not.toBeNull();
    expect(byText(".cu-phone-tools button", "Earlier (1)")).not.toBeNull();
    const controls = controlsIn(band());
    expect(controls).toHaveLength(1);
    expect(controls[0]?.classList.contains("cu-big")).toBe(true);
  });
});
