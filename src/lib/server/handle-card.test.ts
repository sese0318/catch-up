import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../card/parse", async () => (await import("./test-support")).cardParseFake);
vi.mock("../card/prompt", async () => (await import("./test-support")).cardPromptFake);
vi.mock("../card/fixtures", async () => (await import("./test-support")).cardFixturesFake);

import { HealthResponse, LIMITS, WireCard, type StreamEvent } from "../protocol";
import { createMockProvider } from "../providers";
import { forgetMissedSlugs } from "../providers/open-weights";
import { ProviderError, type CardHandlerDeps, type CardProvider, type PressLogEntry, type ProviderId } from "../providers/types";
import { readServerEnv } from "./env";
import { pressGuards } from "./guards";
import { handleCardRequest, handleHealthRequest } from "./handle-card";
import {
  BASETEN_TEST_KEY,
  META_TEST_KEY,
  SECRET_HINT,
  SECRET_NAME,
  cardRequest,
  chatStream,
  eventsOf,
  fakeFetch,
  fakeProvider,
  makeWav,
  namesOf,
  okResult,
  sampleCard,
  statusReply,
  testEnv,
  testMeta,
  untilAborted,
} from "./test-support";

const B_MODEL = "meta-models/muse-spark-open-1026";
const A_MODEL = "muse-voice-transcribe-1.0 + muse-spark-1.3";

function setup(patch: Omit<CardHandlerDeps, "log"> = {}) {
  const logs: PressLogEntry[] = [];
  const deps: CardHandlerDeps = { env: testEnv(), log: (entry) => logs.push(entry), ...patch };
  return { deps, logs };
}

function live(behavior: Partial<Record<"b" | "a", CardProvider["run"]>> = {}) {
  const b = fakeProvider(
    "open_weights",
    behavior.b ??
      (async ({ onStage }) => {
        onStage({ name: "writing", atMs: 1 });
        return okResult(B_MODEL, { usage: { inputTokens: 1100, audioTokens: 375, outputTokens: 600 } });
      }),
  );
  const a = fakeProvider(
    "meta_api",
    behavior.a ??
      (async ({ onStage }) => {
        onStage({ name: "writing", atMs: 1 });
        return okResult(A_MODEL, { transcript: "So, does Thursday work?", timings: { totalMs: 10, asrMs: 4 } });
      }),
  );
  return { b, a, providers: { open_weights: b, meta_api: a } as Partial<Record<ProviderId, CardProvider>> };
}

function cardOf(events: StreamEvent[]): WireCard {
  const card = events.find((e) => e.event === "card");
  if (!card || card.event !== "card") throw new Error(`no card in ${namesOf(events).join(", ")}`);
  return card.data;
}

function errorOf(events: StreamEvent[]) {
  const error = events.find((e) => e.event === "error");
  if (!error || error.event !== "error") throw new Error(`no error in ${namesOf(events).join(", ")}`);
  return error.data;
}

beforeEach(() => {
  pressGuards.reset();
  forgetMissedSlugs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/card, the happy path", () => {
  it("streams received, writing, a Route B card and done, and logs one line", async () => {
    const { b, a, providers } = live();
    let sent: number[] = [];
    b.run = async (input) => {
      sent = [...(input.wav ?? [])];
      input.onStage({ name: "writing", atMs: 1 });
      return okResult(B_MODEL, { usage: { inputTokens: 1100, audioTokens: 375, outputTokens: 600 } });
    };
    const wav = makeWav(2);
    const { deps, logs } = setup({ providers });
    const res = await handleCardRequest(cardRequest({ body: wav }), deps);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const events = await eventsOf(res);
    expect(namesOf(events)).toEqual(["stage:received", "stage:writing", "card", "done"]);
    expect(sent).toEqual([...wav]);
    expect(a.runs).toBe(0);

    const card = cardOf(events);
    expect(card).toMatchObject({ ...sampleCard, meta: { route: "open_weights", model: B_MODEL, parse: "clean" } });
    expect(card.meta.fallbackFrom).toBeUndefined();
    expect(card.meta.timing.bytes).toBe(wav.byteLength);
    expect(card.meta.timing.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(card.meta.usage).toEqual({ inputTokens: 1100, audioTokens: 375, outputTokens: 600 });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      status: "ok",
      route: "open_weights",
      model: B_MODEL,
      fallback: false,
      parse: "clean",
      windowSec: 30,
      sentSec: 30,
      bytes: wav.byteLength,
    });
  });

  it("runs the real providers end to end with a fake upstream, falling back from a 404 to Route A", async () => {
    const { fetchImpl, calls } = fakeFetch(
      statusReply(404),
      Response.json({ transcript: "So, does Thursday work?", audioDurationMs: 2000 }),
      chatStream(),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const { deps } = setup();
    const events = await eventsOf(await handleCardRequest(cardRequest(), deps));
    expect(namesOf(events)).toEqual(["stage:received", "stage:fallback", "stage:writing", "card", "done"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://inference.baseten.co/v1/chat/completions",
      "https://api.meta.ai/v1/asr/transcribe",
      "https://api.meta.ai/v1/chat/completions",
    ]);
    const card = cardOf(events);
    expect(card.meta).toMatchObject({
      route: "meta_api",
      model: A_MODEL,
      fallbackFrom: "open_weights",
      fallbackCause: "http",
      transcript: "So, does Thursday work?",
    });
    expect(card.meta.timing.asrMs).toBeGreaterThanOrEqual(0);
    expect(card.meta.usage).toMatchObject({ audioSeconds: 2 });
  });
});

describe("Auto fallback", () => {
  it("switches to Route A once on a Route B error and names the cause", async () => {
    const { b, a, providers } = live({ b: async () => Promise.reject(new ProviderError("http", "open_weights", { status: 503 })) });
    const { deps, logs } = setup({ providers });
    const events = await eventsOf(await handleCardRequest(cardRequest(), deps));
    expect(namesOf(events)).toEqual(["stage:received", "stage:fallback", "stage:writing", "card", "done"]);
    const card = cardOf(events);
    expect(card.meta).toMatchObject({ route: "meta_api", model: A_MODEL, fallbackFrom: "open_weights", fallbackCause: "http" });
    expect(card.meta.timing.fallbackAtMs).toBeGreaterThanOrEqual(0);
    expect(card.meta.timing.asrMs).toBe(4);
    expect([b.runs, a.runs]).toEqual([1, 1]);
    expect(logs[0]).toMatchObject({ status: "ok", route: "meta_api", fallback: true, cause: "http" });
  });

  it("switches when Route B output does not parse", async () => {
    const { providers } = live({
      b: async () => Promise.reject(new ProviderError("bad_json", "open_weights", { raw: "not json", model: B_MODEL })),
    });
    const { deps } = setup({ providers });
    const card = cardOf(await eventsOf(await handleCardRequest(cardRequest(), deps)));
    expect(card.meta).toMatchObject({ route: "meta_api", fallbackCause: "bad_json" });
    expect(card.meta.unformatted).toBeUndefined();
  });

  it("switches when Route B has no answer token by AUTO_FALLBACK_MS", async () => {
    let bSignal: AbortSignal | undefined;
    const { providers } = live({
      b: ({ signal }) => {
        bSignal = signal;
        return untilAborted(signal);
      },
    });
    const { deps } = setup({ providers, env: testEnv({ autoFallbackMs: 30 }) });
    const events = await eventsOf(await handleCardRequest(cardRequest(), deps));
    expect(namesOf(events)).toEqual(["stage:received", "stage:fallback", "stage:writing", "card", "done"]);
    expect(cardOf(events).meta.fallbackCause).toBe("no_token");
    expect(bSignal?.aborted).toBe(true);
  });

  it("keeps Route B once its first token arrived, even past AUTO_FALLBACK_MS", async () => {
    const { a, providers } = live({
      b: async ({ onStage }) => {
        onStage({ name: "writing", atMs: 1 });
        await new Promise((resolve) => setTimeout(resolve, 60));
        return okResult(B_MODEL);
      },
    });
    const { deps } = setup({ providers, env: testEnv({ autoFallbackMs: 30 }) });
    const card = cardOf(await eventsOf(await handleCardRequest(cardRequest(), deps)));
    expect(card.meta.route).toBe("open_weights");
    expect(a.runs).toBe(0);
  });

  it("does not wait for a provider that ignores its signal", async () => {
    const { providers } = live({ b: () => new Promise(() => undefined) });
    const { deps } = setup({ providers, env: testEnv({ autoFallbackMs: 30 }) });
    const card = cardOf(await eventsOf(await handleCardRequest(cardRequest(), deps)));
    expect(card.meta).toMatchObject({ route: "meta_api", fallbackCause: "no_token" });
  });

  it("falls back on a provider bug too, without a cause", async () => {
    const { providers } = live({
      b: async () => {
        throw new TypeError("boom");
      },
    });
    const { deps } = setup({ providers });
    const card = cardOf(await eventsOf(await handleCardRequest(cardRequest(), deps)));
    expect(card.meta.route).toBe("meta_api");
    expect(card.meta.fallbackFrom).toBe("open_weights");
    expect(card.meta.fallbackCause).toBeUndefined();
  });

  it("never falls back from a pinned route", async () => {
    const { a, providers } = live({ b: async () => Promise.reject(new ProviderError("http", "open_weights", { status: 500 })) });
    const { deps, logs } = setup({ providers });
    const events = await eventsOf(await handleCardRequest(cardRequest({ meta: testMeta({ route: "open_weights" }) }), deps));
    expect(namesOf(events)).toEqual(["stage:received", "error", "done"]);
    expect(errorOf(events)).toEqual({ code: "provider_error", retryable: true, stored: false, route: "open_weights", cause: "http" });
    expect(a.runs).toBe(0);
    expect(logs[0]).toMatchObject({ status: "error", code: "provider_error", cause: "http", route: "open_weights" });
  });

  it("does not fall back on a failure another route cannot fix", async () => {
    const { a, providers } = live({ b: async () => Promise.reject(new ProviderError("bad_input", "open_weights")) });
    const { deps } = setup({ providers });
    const events = await eventsOf(await handleCardRequest(cardRequest(), deps));
    expect(errorOf(events)).toMatchObject({ code: "provider_error", cause: "bad_input" });
    expect(a.runs).toBe(0);
  });

  it("retries a lone Route B once when its JSON does not parse", async () => {
    let calls = 0;
    const { providers } = live({
      b: async () => {
        calls += 1;
        if (calls === 1) throw new ProviderError("bad_json", "open_weights", { raw: "nope", model: B_MODEL });
        return okResult(B_MODEL);
      },
    });
    const { deps } = setup({ providers: { open_weights: providers.open_weights }, env: testEnv({ meta: { apiKey: null } }) });
    const events = await eventsOf(await handleCardRequest(cardRequest(), deps));
    expect(namesOf(events)).toEqual(["stage:received", "card", "done"]);
    expect(calls).toBe(2);
    expect(cardOf(events).meta.route).toBe("open_weights");
  });

  it("sends an Unformatted card when every route fails but model text exists", async () => {
    const { providers } = live({
      b: async () => Promise.reject(new ProviderError("bad_json", "open_weights", { raw: "B text", model: B_MODEL })),
      a: async () =>
        Promise.reject(
          new ProviderError("length", "meta_api", { raw: '{"heard":"cle', transcript: "the words", model: A_MODEL }),
        ),
    });
    const { deps, logs } = setup({ providers });
    const events = await eventsOf(await handleCardRequest(cardRequest(), deps));
    expect(namesOf(events)).toEqual(["stage:received", "stage:fallback", "card", "done"]);
    const card = cardOf(events);
    expect(card.summary[0]).toBe('{"heard":"cle');
    expect(card.meta).toMatchObject({
      route: "meta_api",
      model: A_MODEL,
      unformatted: true,
      parse: "unformatted",
      transcript: "the words",
      fallbackFrom: "open_weights",
      fallbackCause: "bad_json",
    });
    expect(logs[0]).toMatchObject({ status: "ok", parse: "unformatted", cause: "length", fallback: true });
  });

  it("sends an error naming the last route when every route fails without text", async () => {
    const { providers } = live({
      b: async () => Promise.reject(new ProviderError("http", "open_weights", { status: 503 })),
      a: async () => Promise.reject(new ProviderError("rate_limited", "meta_api", { status: 429, retryAfterSec: 9 })),
    });
    const { deps } = setup({ providers });
    const events = await eventsOf(await handleCardRequest(cardRequest(), deps));
    expect(namesOf(events)).toEqual(["stage:received", "stage:fallback", "error", "done"]);
    expect(errorOf(events)).toEqual({
      code: "provider_error",
      retryable: true,
      stored: false,
      route: "meta_api",
      cause: "rate_limited",
      retryAfterSec: 9,
    });
  });

  it("stops every provider at 19 s and sends timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { a, providers } = live({ b: ({ signal }) => untilAborted(signal), a: ({ signal }) => untilAborted(signal) });
    const { deps, logs } = setup({ providers });
    const res = await handleCardRequest(cardRequest(), deps);
    const pending = eventsOf(res);
    await vi.advanceTimersByTimeAsync(19_000);
    const events = await pending;
    expect(namesOf(events)).toEqual(["stage:received", "stage:fallback", "error", "done"]);
    const fallback = events[1];
    expect(fallback.event === "stage" && fallback.data.ms).toBe(8_000);
    expect(errorOf(events)).toEqual({ code: "timeout", retryable: true, stored: false, route: "meta_api", cause: "timeout" });
    expect(a.runs).toBe(1);
    expect(logs[0]).toMatchObject({ status: "error", code: "timeout", ms: { total: 19_000 } });
  });

  it("stops and logs aborted when the client goes away", async () => {
    const ctl = new AbortController();
    let bSignal: AbortSignal | undefined;
    const { a, providers } = live({
      b: ({ signal }) => {
        bSignal = signal;
        return untilAborted(signal);
      },
    });
    const { deps, logs } = setup({ providers });
    const res = await handleCardRequest(cardRequest({ signal: ctl.signal }), deps);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("received");
    ctl.abort();
    expect((await reader.read()).done).toBe(true);
    expect(bSignal?.aborted).toBe(true);
    expect(a.runs).toBe(0);
    expect(logs).toEqual([expect.objectContaining({ status: "error", code: "aborted" })]);
  });

  it("stops when the reader cancels the stream", async () => {
    let bSignal: AbortSignal | undefined;
    const { providers } = live({
      b: ({ signal }) => {
        bSignal = signal;
        return untilAborted(signal);
      },
    });
    const { deps, logs } = setup({ providers });
    const res = await handleCardRequest(cardRequest(), deps);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(bSignal?.aborted).toBe(true);
    expect(logs[0]).toMatchObject({ code: "aborted" });
  });
});

describe("checks before streaming", () => {
  it("refuses a missing or broken X-CatchUp-Meta header", async () => {
    const { deps, logs } = setup({ providers: live().providers });
    for (const header of [null, "%%%", "eyJ2IjoyfQ"]) {
      const res = await handleCardRequest(cardRequest({ header }), deps);
      expect(res.status).toBe(400);
      expect(errorOf(await eventsOf(res))).toEqual({ code: "bad_request", retryable: false, stored: false });
    }
    expect(logs.map((l) => l.code)).toEqual(["bad_request", "bad_request", "bad_request"]);
  });

  it("refuses an unknown content type and a transcript outside Route A", async () => {
    const { deps } = setup({ providers: live().providers });
    const json = await handleCardRequest(cardRequest({ contentType: "application/json" }), deps);
    expect(json.status).toBe(400);
    const text = await handleCardRequest(cardRequest({ contentType: "text/plain; charset=utf-8", body: "words" }), deps);
    expect(text.status).toBe(400);
    expect(errorOf(await eventsOf(text)).code).toBe("bad_request");
  });

  it("refuses audio that is not 16 kHz mono PCM16 between 1 s and 125 s", async () => {
    const { deps } = setup({ providers: live().providers });
    const cases: [Uint8Array, number, string][] = [
      [new TextEncoder().encode("not a wav file at all, just some text bytes here"), 400, "bad_audio"],
      [makeWav(2, 8_000), 400, "bad_audio"],
      [makeWav(0.5), 400, "bad_audio"],
      [makeWav(126), 413, "too_large"],
    ];
    for (const [body, status, code] of cases) {
      const res = await handleCardRequest(cardRequest({ body: body as Uint8Array<ArrayBuffer> }), deps);
      expect(res.status).toBe(status);
      expect(errorOf(await eventsOf(res)).code).toBe(code);
    }
  });

  it("caps the body while reading and before reading", async () => {
    const { deps } = setup({ providers: live().providers });
    const big = new Uint8Array(LIMITS.maxBodyBytes + 1);
    const res = await handleCardRequest(cardRequest({ body: big }), deps);
    expect(res.status).toBe(413);
    expect(errorOf(await eventsOf(res)).code).toBe("too_large");

    const declared = cardRequest({ headers: { "Content-Length": String(LIMITS.maxBodyBytes + 1) } });
    const early = await handleCardRequest(declared, deps);
    expect(early.status).toBe(413);
    expect(declared.bodyUsed).toBe(false);
  });

  it("accepts a transcript body for a Route A language redo", async () => {
    const { a, providers } = live();
    let seen: { wav: Uint8Array | null; transcript: string | null } | null = null;
    a.run = async (input) => {
      seen = { wav: input.wav, transcript: input.transcript };
      return okResult("muse-spark-1.3", { transcript: input.transcript ?? undefined });
    };
    const { deps } = setup({ providers });
    const req = cardRequest({
      meta: testMeta({ route: "meta_api", cardLang: "zh" }),
      contentType: "text/plain; charset=utf-8",
      body: "  So, does Thursday work?  ",
    });
    const card = cardOf(await eventsOf(await handleCardRequest(req, deps)));
    expect(seen).toEqual({ wav: null, transcript: "So, does Thursday work?" });
    expect(card.meta).toMatchObject({ route: "meta_api", model: "muse-spark-1.3" });
    expect(card.meta.timing.bytes).toBe(27);

    const tooLong = cardRequest({
      meta: testMeta({ route: "meta_api" }),
      contentType: "text/plain; charset=utf-8",
      body: "a".repeat(LIMITS.maxTranscriptBytes + 1),
    });
    expect((await handleCardRequest(tooLong, deps)).status).toBe(413);
    const blank = cardRequest({ meta: testMeta({ route: "meta_api" }), contentType: "text/plain", body: "   " });
    expect((await handleCardRequest(blank, deps)).status).toBe(400);
  });

  it("answers not_configured without keys and live_off with the kill switch", async () => {
    const keyless = setup({ env: readServerEnv({}) });
    const res = await handleCardRequest(cardRequest(), keyless.deps);
    expect(res.status).toBe(503);
    expect(errorOf(await eventsOf(res)).code).toBe("not_configured");

    const off = setup({ env: testEnv({ liveEnabled: false }), providers: live().providers });
    const req = cardRequest();
    const stopped = await handleCardRequest(req, off.deps);
    expect(stopped.status).toBe(503);
    expect(errorOf(await eventsOf(stopped)).code).toBe("live_off");
    expect(req.bodyUsed).toBe(false);
  });
});

describe("mock", () => {
  const mockMeta = (mode: "ok" | "slow" | "error" | "badjson" = "ok") =>
    testMeta({ route: "mock", mock: { mode, fixture: "you" }, cardLang: "en" });

  it("is refused in production even with ALLOW_MOCK=1", async () => {
    const { deps, logs } = setup({ env: readServerEnv({ ALLOW_MOCK: "1", NODE_ENV: "production" }) });
    const res = await handleCardRequest(cardRequest({ meta: mockMeta() }), deps);
    expect(res.status).toBe(403);
    expect(errorOf(await eventsOf(res)).code).toBe("mock_refused");
    expect(logs[0]).toMatchObject({ status: "error", code: "mock_refused" });
  });

  it("streams the fixture with stages when allowed, without counting toward the guards", async () => {
    const env = testEnv({ allowMock: true, ratePerHour: 1, dailyCap: 1 });
    const { deps } = setup({ env, providers: { ...live().providers, mock: createMockProvider(env, { timeScale: 0 }) } });
    for (let i = 0; i < 3; i++) {
      const events = await eventsOf(await handleCardRequest(cardRequest({ meta: mockMeta() }), deps));
      expect(namesOf(events)).toEqual(["stage:received", "stage:writing", "card", "done"]);
      expect(cardOf(events).meta).toMatchObject({ route: "mock", model: "mock", parse: "clean" });
    }
    expect((await handleCardRequest(cardRequest(), deps)).status).toBe(200);
    expect((await handleCardRequest(cardRequest(), deps)).status).toBe(429);
    expect((await handleCardRequest(cardRequest({ meta: mockMeta() }), deps)).status).toBe(200);
  });

  it("ends in an error or an Unformatted card for the error and badjson modes", async () => {
    const env = testEnv({ allowMock: true });
    const { deps } = setup({ env, providers: { mock: createMockProvider(env, { timeScale: 0 }) } });
    const failed = await eventsOf(await handleCardRequest(cardRequest({ meta: mockMeta("error") }), deps));
    expect(errorOf(failed)).toEqual({ code: "provider_error", retryable: true, stored: false, cause: "http" });
    const broken = cardOf(await eventsOf(await handleCardRequest(cardRequest({ meta: mockMeta("badjson") }), deps)));
    expect(broken.meta).toMatchObject({ route: "mock", unformatted: true, parse: "unformatted" });
  });
});

describe("guards", () => {
  const from = (ip: string) => cardRequest({ headers: { "X-Forwarded-For": ip } });

  it("limits live presses per client per hour, keyed by the first x-forwarded-for address", async () => {
    const { deps, logs } = setup({ env: testEnv({ ratePerHour: 2 }), providers: live().providers });
    expect((await handleCardRequest(from("203.0.113.5, 10.0.0.1"), deps)).status).toBe(200);
    expect((await handleCardRequest(from("203.0.113.5, 10.0.0.2"), deps)).status).toBe(200);
    const req = from("203.0.113.5");
    const limited = await handleCardRequest(req, deps);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(3_500);
    const error = errorOf(await eventsOf(limited));
    expect(error).toMatchObject({ code: "rate_limited", retryable: true, stored: false });
    expect(error.retryAfterSec).toBeGreaterThan(3_500);
    expect(req.bodyUsed).toBe(false);
    expect((await handleCardRequest(from("198.51.100.7"), deps)).status).toBe(200);
    expect(JSON.stringify(logs)).not.toContain("203.0.113.5");
  });

  it("uses deps.clientKey when given, and the local key without a forwarded address", async () => {
    const { deps } = setup({ env: testEnv({ ratePerHour: 1 }), providers: live().providers, clientKey: () => "eval-run-7" });
    expect((await handleCardRequest(from("203.0.113.5"), deps)).status).toBe(200);
    expect((await handleCardRequest(from("198.51.100.7"), deps)).status).toBe(429);

    const local = setup({ env: testEnv({ ratePerHour: 1 }), providers: live().providers });
    expect((await handleCardRequest(cardRequest(), local.deps)).status).toBe(200);
    expect((await handleCardRequest(cardRequest(), local.deps)).status).toBe(429);
  });

  it("turns the hourly limit off with 0", async () => {
    const { deps } = setup({ env: testEnv({ ratePerHour: 0 }), providers: live().providers });
    for (let i = 0; i < 5; i++) expect((await handleCardRequest(cardRequest(), deps)).status).toBe(200);
  });

  it("counts a press only after its body passes", async () => {
    const { deps } = setup({ env: testEnv({ ratePerHour: 1 }), providers: live().providers });
    expect((await handleCardRequest(cardRequest({ body: makeWav(0.2) }), deps)).status).toBe(400);
    expect((await handleCardRequest(cardRequest({ header: "%%%" }), deps)).status).toBe(400);
    expect((await handleCardRequest(cardRequest(), deps)).status).toBe(200);
    expect((await handleCardRequest(cardRequest(), deps)).status).toBe(429);
  });

  it("stops live presses at the daily cap and reports it in health", async () => {
    const env = testEnv({ dailyCap: 2 });
    const { deps } = setup({ env, providers: live().providers });
    expect((await handleCardRequest(from("203.0.113.1"), deps)).status).toBe(200);
    expect((await handleCardRequest(from("203.0.113.2"), deps)).status).toBe(200);
    const req = from("203.0.113.3");
    const capped = await handleCardRequest(req, deps);
    expect(capped.status).toBe(503);
    expect(errorOf(await eventsOf(capped))).toEqual({ code: "daily_cap", retryable: false, stored: false });
    expect(req.bodyUsed).toBe(false);
    const health = HealthResponse.parse(await handleHealthRequest({ env }).json());
    expect(health).toMatchObject({ live: false, paused: "daily_cap" });
  });
});

describe("logging", () => {
  it("never logs names, hints, transcripts, card text, model text, IPs or keys", async () => {
    const { providers } = live({
      b: async () => Promise.reject(new ProviderError("bad_json", "open_weights", { raw: "RAW MODEL TEXT", model: B_MODEL })),
      a: async () => okResult(A_MODEL, { transcript: "TRANSCRIPT WORDS" }),
    });
    const { deps, logs } = setup({ providers });
    const req = cardRequest({ headers: { "X-Forwarded-For": "203.0.113.99" } });
    await eventsOf(await handleCardRequest(req, deps));
    const text = JSON.stringify(logs);
    for (const secret of [SECRET_NAME, SECRET_HINT, "Quillfeather", "RAW MODEL TEXT", "TRANSCRIPT WORDS", sampleCard.summary[0], "203.0.113.99", BASETEN_TEST_KEY, META_TEST_KEY]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(logs[0]).sort()).toEqual(
      ["at", "bytes", "cause", "fallback", "model", "ms", "parse", "route", "sentSec", "status", "windowSec"].sort(),
    );
  });

  it("writes one JSON line through console.info by default", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await eventsOf(await handleCardRequest(cardRequest(), { env: testEnv(), providers: live().providers }));
    expect(info).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(info.mock.calls[0][0])) as PressLogEntry;
    expect(entry).toMatchObject({ status: "ok", route: "open_weights", model: B_MODEL });
    expect(String(info.mock.calls[0][0])).not.toContain(SECRET_NAME);
  });
});

describe("GET /api/health", () => {
  it("reports no keys as unconfigured routes and never returns key material", async () => {
    const keyless = handleHealthRequest({ env: readServerEnv({}) });
    expect(keyless.headers.get("cache-control")).toBe("no-store");
    const body = HealthResponse.parse(await keyless.json());
    expect(body).toEqual({
      ok: true,
      v: 1,
      live: true,
      paused: null,
      defaultRoute: "auto",
      mock: false,
      routes: {
        open_weights: { configured: false, model: B_MODEL, provider: "Baseten" },
        meta_api: { configured: false, model: A_MODEL, provider: "Meta Model API" },
      },
      limits: { maxBodyBytes: LIMITS.maxBodyBytes, maxClipSec: LIMITS.maxClipSec, perHour: 30, hardCapMs: LIMITS.hardCapMs },
    });

    const keyed = await handleHealthRequest({ env: testEnv() }).text();
    expect(keyed).not.toContain(BASETEN_TEST_KEY);
    expect(keyed).not.toContain(META_TEST_KEY);
    expect(JSON.parse(keyed).routes.open_weights.configured).toBe(true);
  });

  it("reports the kill switch", async () => {
    const body = HealthResponse.parse(await handleHealthRequest({ env: testEnv({ liveEnabled: false, allowMock: true }) }).json());
    expect(body).toMatchObject({ live: false, paused: "live_off", mock: true });
  });
});
