// The mock route (ux-spec 7, Modes 3). Dev and tests only. readServerEnv sets allowMock only when
// ALLOW_MOCK is 1 and NODE_ENV is not production, and planRoutes refuses mock otherwise. No model is
// called and no audio is read. Never filmed and never in the README.
import { mockCardBody } from "../card/fixtures";
import type { MockMode, PressMeta } from "../protocol";
import { ProviderError, type CardProvider, type ServerEnv } from "./types";

/** meta.model on a mock card. */
export const MOCK_MODEL = "mock";

/**
 * Milliseconds after the request arrives. ok and badjson follow ux-spec 7 (stages at 0.3 s and 1.2 s,
 * the card at 2.8 s). slow passes the 6 s Still working note and lands well inside the 30 s cap.
 * error fails at 1.2 s, and badjson ends in an Unformatted card built from truncated card JSON.
 */
export const MOCK_TIMELINE: Readonly<Record<MockMode, { receivedMs: number; writingMs: number | null; endMs: number }>> = {
  ok: { receivedMs: 300, writingMs: 1_200, endMs: 2_800 },
  slow: { receivedMs: 300, writingMs: 6_500, endMs: 9_000 },
  error: { receivedMs: 300, writingMs: null, endMs: 1_200 },
  badjson: { receivedMs: 300, writingMs: 1_200, endMs: 2_800 },
};

export interface MockProviderOptions {
  /** Multiplies every delay. Tests pass 0. */
  timeScale?: number;
  now?: () => number;
}

export interface MockCardProvider extends CardProvider {
  readonly id: "mock";
  /** How long the handler holds the received stage, standing in for the upload. */
  receivedDelayMs(meta: PressMeta): number;
}

export function isMockProvider(provider: CardProvider): provider is MockCardProvider {
  return provider.id === "mock" && typeof (provider as Partial<MockCardProvider>).receivedDelayMs === "function";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError("aborted", "mock"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("aborted", "mock"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockProvider(env: ServerEnv, options: MockProviderOptions = {}): MockCardProvider {
  const scale = options.timeScale ?? 1;
  const now = options.now ?? Date.now;
  const modeOf = (meta: PressMeta): MockMode => meta.mock?.mode ?? "ok";

  return {
    id: "mock",
    isConfigured: () => env.allowMock,
    modelLabel: () => MOCK_MODEL,
    receivedDelayMs: (meta) => MOCK_TIMELINE[modeOf(meta)].receivedMs * scale,

    async run({ meta, signal, onStage }) {
      const started = now();
      if (!env.allowMock) throw new ProviderError("not_configured", "mock");
      const mode = modeOf(meta);
      const timeline = MOCK_TIMELINE[mode];
      const after = (ms: number) => Math.max(0, ms - timeline.receivedMs) * scale;

      if (timeline.writingMs === null) {
        await sleep(after(timeline.endMs), signal);
        throw new ProviderError("http", "mock", { status: 502, model: MOCK_MODEL });
      }
      await sleep(after(timeline.writingMs), signal);
      const firstTokenMs = now() - started;
      onStage({ name: "writing", atMs: firstTokenMs });
      await sleep(after(timeline.endMs) - after(timeline.writingMs), signal);

      const body = mockCardBody(meta.mock?.fixture ?? "you", meta.cardLang);
      if (mode === "badjson") {
        const json = JSON.stringify(body);
        throw new ProviderError("bad_json", "mock", { status: 200, raw: json.slice(0, Math.ceil(json.length * 0.6)), model: MOCK_MODEL });
      }
      return { body, model: MOCK_MODEL, parse: "clean", timings: { totalMs: now() - started, firstTokenMs } };
    },
  };
}
