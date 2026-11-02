// Test helpers for the server lane. Imported only by *.test.ts files, never by app code.
// The card lane fakes stand in for src/lib/card/{parse,prompt,fixtures}.ts through vi.mock until
// that lane lands, so the server tests check the server's own logic only.
import type { ClampContext, ParseOutcome } from "../card/parse";
import type { PromptInput } from "../card/prompt";
import { CardBody, type CardLang } from "../card/schema";
import {
  encodeMetaHeader,
  readEventStream,
  type MockFixtureKind,
  type PressMeta,
  type StreamEvent,
} from "../protocol";
import { ENV_DEFAULTS, type CardProvider, type ProviderId, type ProviderResult, type ServerEnv } from "../providers/types";

export const BASETEN_TEST_KEY = "b10_TESTKEYX.0123456789abcdef0123456789abcdef";
export const META_TEST_KEY = "LLM_1234567890_testsecret";

export function testEnv(patch: Partial<Omit<ServerEnv, "baseten" | "meta">> & {
  baseten?: Partial<ServerEnv["baseten"]>;
  meta?: Partial<ServerEnv["meta"]>;
} = {}): ServerEnv {
  const { baseten, meta, ...rest } = patch;
  return {
    baseten: {
      apiKey: BASETEN_TEST_KEY,
      baseUrl: ENV_DEFAULTS.BASETEN_BASE_URL,
      model: ENV_DEFAULTS.BASETEN_MODEL,
      modelFallback: null,
      maxTokens: ENV_DEFAULTS.BASETEN_MAX_TOKENS,
      temperature: ENV_DEFAULTS.BASETEN_TEMPERATURE,
      topK: null,
      ...baseten,
    },
    meta: {
      apiKey: META_TEST_KEY,
      baseUrl: ENV_DEFAULTS.META_BASE_URL,
      cardModel: ENV_DEFAULTS.META_CARD_MODEL,
      asrModel: ENV_DEFAULTS.META_ASR_MODEL,
      maxCompletionTokens: ENV_DEFAULTS.META_MAX_COMPLETION_TOKENS,
      ...meta,
    },
    routePolicy: "auto",
    liveEnabled: true,
    allowMock: false,
    ratePerHour: 0,
    dailyCap: 10_000,
    autoFallbackMs: ENV_DEFAULTS.AUTO_FALLBACK_MS,
    ...rest,
  };
}

export const SECRET_NAME = "Zephyrine";
export const SECRET_HINT = "Quillfeather, Project Marmalade";

export function testMeta(patch: Partial<PressMeta> = {}): PressMeta {
  return {
    v: 1,
    pressedAt: "2026-11-02T10:42:40.123-05:00",
    tz: "America/New_York",
    cardLang: "ja",
    meetingLang: "en",
    windowSec: 30,
    sentSec: 30,
    source: "tab",
    names: [SECRET_NAME, "ゼフィ"],
    hint: SECRET_HINT,
    route: "auto",
    sessionId: "sess_0123456789abcdef",
    ...patch,
  };
}

/** A 16 kHz mono PCM16 WAV with a quiet sine, so the samples are not all zero. */
export function makeWav(seconds = 2, sampleRate = 16_000): Uint8Array<ArrayBuffer> {
  const samples = Math.round(seconds * sampleRate);
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, out.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / 8) * 3000), true);
  return out;
}

export const sampleCard: CardBody = {
  heard: "clear",
  ask: { to: "you", text: "デモは木曜でいいか", by: "Alex" },
  say: { text: "Just to check, Thursday for the demo?", lang: "en", gloss: "確認です。デモは木曜ですか。" },
  summary: ["デモの日程を聞かれた"],
  facts: [{ kind: "date", text: "11月5日(木)", note: "Thursday" }],
  quote: "Does Thursday work for the demo?",
};

export const sampleCardJson = JSON.stringify(sampleCard);

// Card lane fakes, shaped like the real exports.

export const cardParseFake = {
  stripModelText: (raw: string) => raw.replace(/<\|[^|]*\|>/g, "").replace(/```(?:json)?/gi, "").trim(),
  extractJsonObject: (text: string): string | null => {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    return start >= 0 && end > start ? text.slice(start, end + 1) : null;
  },
  clampCardBody: (input: unknown) => {
    const parsed = CardBody.safeParse(input);
    return parsed.success ? { body: parsed.data, quality: "clean" as const } : null;
  },
  applyNumberBackstop: (body: CardBody) => body,
  parseCardText: (raw: string, ctx: ClampContext): ParseOutcome => {
    void ctx;
    const text = cardParseFake.stripModelText(raw);
    if (!text) return { ok: false, reason: "empty" };
    const json = cardParseFake.extractJsonObject(text);
    if (json === null) return { ok: false, reason: "no_json" };
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return { ok: false, reason: "bad_json" };
    }
    const clamped = cardParseFake.clampCardBody(value);
    return clamped ? { ok: true, ...clamped } : { ok: false, reason: "not_card" };
  },
  unformattedBody: (raw: string, ctx: ClampContext): CardBody => {
    void ctx;
    return { heard: "partial", ask: { to: "none" }, summary: [cardParseFake.stripModelText(raw).slice(0, 2000)], facts: [] };
  },
};

export const cardPromptFake = {
  PROMPT_VERSION: "card-test",
  systemPrompt: () => "SYSTEM PROMPT",
  promptInputFromMeta: (meta: PressMeta, transcript?: string | null): PromptInput => ({
    cardLang: meta.cardLang,
    meetingLang: meta.meetingLang,
    names: meta.names,
    hint: meta.hint ?? "",
    nowIso: meta.pressedAt,
    weekday: "Monday",
    tz: meta.tz ?? null,
    windowSec: meta.windowSec,
    source: meta.source,
    transcript: transcript ?? null,
  }),
  userText: (input: PromptInput) =>
    [`card ${input.cardLang}`, `meeting ${input.meetingLang}`, ...(input.transcript !== null ? [`transcript ${input.transcript}`] : [])].join("\n"),
};

export const cardFixturesFake = {
  mockCardBody: (kind: MockFixtureKind, lang: CardLang): CardBody => ({
    heard: kind === "no_speech" ? "none" : "clear",
    ask: kind === "you" ? { to: "you", text: `Mock question in ${lang}` } : { to: "none" },
    summary: [`Mock ${kind} card in ${lang}`],
    facts: [],
  }),
};

// Upstream fakes.

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export type FakeReply = Response | ((call: FetchCall) => Response | Promise<Response>);

/** A fetch that answers from a queue and records every call. An empty queue is a test bug. */
export function fakeFetch(...replies: FakeReply[]) {
  const calls: FetchCall[] = [];
  const queue = [...replies];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const call = { url, init };
    calls.push(call);
    if (init.signal?.aborted) throw init.signal.reason;
    const reply = queue.shift();
    if (!reply) throw new Error(`unexpected fetch ${calls.length} to ${url}`);
    return typeof reply === "function" ? reply(call) : reply;
  };
  return { fetchImpl, calls };
}

export function jsonBodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

export function headersOf(call: FetchCall): Record<string, string> {
  return Object.fromEntries(new Headers(call.init.headers).entries());
}

export interface ChatStreamSpec {
  content?: string[];
  reasoning?: string[];
  finish?: string | null;
  refusal?: string;
  usage?: Record<string, unknown>;
  done?: boolean;
  status?: number;
}

/** An OpenAI-compatible streaming Chat Completions response. */
export function chatStream(spec: ChatStreamSpec = {}): Response {
  const { content = [sampleCardJson], reasoning = [], finish = "stop", refusal, usage, done = true, status = 200 } = spec;
  const chunks: unknown[] = [];
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  chunks.push(chunk({ role: "assistant" }));
  for (const text of reasoning) chunks.push(chunk({ reasoning_content: text }));
  for (const text of content) chunks.push(chunk({ content: text }));
  if (refusal !== undefined) chunks.push(chunk({ refusal }));
  if (finish !== null) chunks.push(chunk({}, finish));
  if (usage) chunks.push({ id: "chatcmpl-test", object: "chat.completion.chunk", choices: [], usage });
  let text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  if (done) text += "data: [DONE]\n\n";
  return new Response(text, { status, headers: { "Content-Type": "text/event-stream" } });
}

/** A stream that never ends on its own, and closes when the request signal fires. */
export function hangingStream(signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export function statusReply(status: number, headers: Record<string, string> = {}): Response {
  return new Response(`{"error":{"message":"upstream ${status}"}}`, { status, headers: { "Content-Type": "application/json", ...headers } });
}

export interface MultipartPart {
  headers: Record<string, string>;
  name: string | null;
  filename: string | null;
  data: Uint8Array;
}

/** Parses a multipart/form-data body back into its parts. */
export function parseMultipart(body: Uint8Array, contentType: string): MultipartPart[] {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error("no boundary");
  const latin = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("latin1");
  const parts: MultipartPart[] = [];
  const delimiter = `--${boundary}`;
  let pos = latin.indexOf(delimiter);
  while (pos >= 0) {
    const start = pos + delimiter.length;
    if (latin.startsWith("--", start)) break;
    const next = latin.indexOf(`\r\n${delimiter}`, start);
    const section = latin.slice(start + 2, next);
    const split = section.indexOf("\r\n\r\n");
    const headers: Record<string, string> = {};
    for (const line of section.slice(0, split).split("\r\n")) {
      const colon = line.indexOf(":");
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const disposition = headers["content-disposition"] ?? "";
    const dataStart = start + 2 + split + 4;
    parts.push({
      headers,
      name: /name="([^"]*)"/.exec(disposition)?.[1] ?? null,
      filename: /filename="([^"]*)"/.exec(disposition)?.[1] ?? null,
      data: body.slice(dataStart, next),
    });
    pos = next + 2;
  }
  return parts;
}

// Handler helpers.

export function cardRequest(
  options: {
    meta?: PressMeta;
    header?: string | null;
    body?: BodyInit | null;
    contentType?: string | null;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  const header = options.header === undefined ? encodeMetaHeader(options.meta ?? testMeta()) : options.header;
  if (header !== null) headers.set("X-CatchUp-Meta", header);
  const contentType = options.contentType === undefined ? "audio/wav" : options.contentType;
  if (contentType !== null) headers.set("Content-Type", contentType);
  return new Request("http://localhost/api/card", {
    method: "POST",
    headers,
    body: options.body === undefined ? makeWav(2) : options.body,
    signal: options.signal,
  });
}

export async function eventsOf(res: Response): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  if (!res.body) return out;
  for await (const event of readEventStream(res.body, (info) => {
    throw new Error(`invalid ${info.name} event (${info.reason})`);
  })) {
    out.push(event);
  }
  return out;
}

export function namesOf(events: StreamEvent[]): string[] {
  return events.map((e) => (e.event === "stage" ? `stage:${e.data.name}` : e.event));
}

/** A provider fake. run gets the input and can resolve, reject or wait for its signal. */
export function fakeProvider(
  id: ProviderId,
  run: CardProvider["run"],
  options: { configured?: boolean; model?: string } = {},
): CardProvider & { runs: number } {
  const provider = {
    id,
    runs: 0,
    isConfigured: () => options.configured ?? true,
    modelLabel: () => options.model ?? `${id}-model`,
    run: (input: Parameters<CardProvider["run"]>[0]) => {
      provider.runs += 1;
      return run(input);
    },
  };
  return provider;
}

export function okResult(model: string, patch: Partial<ProviderResult> = {}): ProviderResult {
  return { body: sampleCard, model, parse: "clean", timings: { totalMs: 10 }, ...patch };
}

/** Resolves never, and rejects when the signal fires, like a provider waiting on the network. */
export function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
