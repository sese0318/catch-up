// Catch Up wire protocol v1 (ux-spec 2-6). Shared by the browser, the server and the eval scripts.
// POST /api/card takes the raw clip as the body (audio/wav, 16 kHz mono PCM16) and the press
// metadata as base64url JSON in the X-CatchUp-Meta header. It answers text/event-stream with
// stage, card, error and done events. Nothing here touches the DOM or Node-only APIs.
import { z } from "zod";
import {
  CAPS,
  CardBody,
  CardLang,
  LiveRoute,
  Source,
  WindowSec,
  widthOf,
  type Card,
  type CardMeta,
  type CardTimings,
} from "./card/schema";

export const PROTOCOL_VERSION = 1 as const;
export const CARD_ENDPOINT = "/api/card";
export const HEALTH_ENDPOINT = "/api/health";
export const META_HEADER = "X-CatchUp-Meta";
export const WAV_CONTENT_TYPE = "audio/wav";
/** Route A language redo sends the earlier transcript instead of audio (route meta_api only). */
export const TRANSCRIPT_CONTENT_TYPE = "text/plain; charset=utf-8";
export const EVENT_STREAM_CONTENT_TYPE = "text/event-stream; charset=utf-8";
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": EVENT_STREAM_CONTENT_TYPE,
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

export const LIMITS = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  bytesPerSecond: 32_000,
  wavHeaderBytes: 44,
  memorySec: 120, // the ring always holds the last 2 minutes
  minClipSec: 1, // the server refuses shorter clips as bad_audio
  maxClipSec: 125, // 120 s plus slack
  maxBodyBytes: 4_400_000, // under Vercel's 4.5 MB request cap
  maxTranscriptBytes: 16_000,
  maxMetaHeaderChars: 4_096,
  warmupSec: 5, // under this much memory the button reads Collecting sound
  hardCapMs: 20_000, // press to card or error, enforced by the client and the server
  stillWorkingMs: 6_000,
  autoFallbackMs: 8_000, // Auto starts Route A when Route B has no answer token by then
  snapshotHoldMs: 120_000, // the press snapshot stays for Further back and language redo, then is zeroed
  quietHintMs: 20_000,
  soundOkFoldMs: 10_000,
} as const;

/** Targets from ux-spec 3 until gate 1 measures them. */
export const TIMING_BUDGET = {
  stallLineMs: 0,
  captureMs: 100, // snapshot, slice, normalize and encode
  encodeMs: 50,
  cardP50Ms: 5_000,
  cardP95Ms: 8_000,
} as const;

export const ROUTE_PREFERENCES = ["auto", "open_weights", "meta_api", "mock"] as const;
export const RoutePreference = z.enum(ROUTE_PREFERENCES);
export type RoutePreference = z.infer<typeof RoutePreference>;

export const MOCK_MODES = ["ok", "slow", "error", "badjson"] as const;
export const MockMode = z.enum(MOCK_MODES);
export type MockMode = z.infer<typeof MockMode>;

export const MOCK_FIXTURE_KINDS = [
  "you",
  "room",
  "mentioned",
  "none",
  "poor",
  "no_speech",
  "unsure_number",
  "mixed",
] as const;
export const MockFixtureKind = z.enum(MOCK_FIXTURE_KINDS);
export type MockFixtureKind = z.infer<typeof MockFixtureKind>;

/** Dev and tests only. The server refuses it when NODE_ENV is production or ALLOW_MOCK is not 1. */
export const MockSpec = z.object({ mode: MockMode, fixture: MockFixtureKind.optional() });
export type MockSpec = z.infer<typeof MockSpec>;

export const STAGE_NAMES = ["received", "writing", "fallback"] as const;
export const StageName = z.enum(STAGE_NAMES);
export type StageName = z.infer<typeof StageName>;

/** Why a provider gave up. Never carries content. */
export const PROVIDER_FAILURES = [
  "not_configured",
  "bad_input",
  "http",
  "rate_limited",
  "timeout",
  "no_token",
  "bad_json",
  "refused",
  "length",
  "empty",
  "aborted",
] as const;
export const ProviderFailure = z.enum(PROVIDER_FAILURES);
export type ProviderFailure = z.infer<typeof ProviderFailure>;

export const PARSE_QUALITIES = ["clean", "clamped", "unformatted"] as const;
export const ParseQuality = z.enum(PARSE_QUALITIES);
export type ParseQuality = z.infer<typeof ParseQuality>;

export const ERROR_CODES = [
  "bad_request",
  "bad_audio",
  "too_large",
  "rate_limited",
  "daily_cap",
  "live_off",
  "not_configured",
  "mock_refused",
  "timeout",
  "provider_error",
  "server_error",
  "offline", // client only
  "network", // client only
  "aborted", // client only
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

// X-CatchUp-Meta header

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Everything the server needs about one press. Nothing else personal travels with a press. */
export const PressMeta = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    pressedAt: z.iso.datetime({ offset: true }), // local time with offset, from toLocalIso
    tz: z.string().min(1).max(64).optional(), // IANA zone such as America/New_York, for resolving relative dates
    cardLang: CardLang,
    meetingLang: CardLang, // soft hint, People around you usually speak
    windowSec: WindowSec,
    sentSec: z.number().min(0).max(LIMITS.maxClipSec),
    source: Source,
    names: z.array(z.string().trim().min(1)).max(3), // forms people call the listener, 60 width units in all
    hint: z.string().trim().min(1).optional(), // per-session names or topics to expect, 120 width units
    route: RoutePreference,
    sessionId: z.string().regex(SESSION_ID), // random per page session, only for x-session-affinity
    mock: MockSpec.optional(), // only with route "mock"
  })
  .superRefine((m, ctx) => {
    if (widthOf(m.names.join(", ")) > CAPS.listenerNames) {
      ctx.addIssue({ code: "custom", path: ["names"], message: "names exceed the width cap" });
    }
    if (m.hint !== undefined && widthOf(m.hint) > CAPS.sessionHint) {
      ctx.addIssue({ code: "custom", path: ["hint"], message: "hint exceeds the width cap" });
    }
    if (m.mock !== undefined && m.route !== "mock") {
      ctx.addIssue({ code: "custom", path: ["mock"], message: "mock needs route mock" });
    }
  });
export type PressMeta = z.infer<typeof PressMeta>;

const textEncoder = new TextEncoder();

function base64UrlEncodeUtf8(text: string): string {
  const bytes = textEncoder.encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeUtf8(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  let b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Validates and encodes press metadata as base64url JSON. Throws on invalid input (a client bug). */
export function encodeMetaHeader(meta: PressMeta): string {
  return base64UrlEncodeUtf8(JSON.stringify(PressMeta.parse(meta)));
}

export type MetaDecodeResult = { ok: true; meta: PressMeta } | { ok: false; issue: string };

/** Decodes the X-CatchUp-Meta header. The issue text names fields only, never values. */
export function decodeMetaHeader(value: string | null | undefined): MetaDecodeResult {
  if (!value) return { ok: false, issue: "missing" };
  if (value.length > LIMITS.maxMetaHeaderChars) return { ok: false, issue: "too_long" };
  const json = base64UrlDecodeUtf8(value.trim());
  if (json === null) return { ok: false, issue: "not_base64url" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, issue: "not_json" };
  }
  const result = PressMeta.safeParse(parsed);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join(".") || "root"))];
    return { ok: false, issue: `invalid ${fields.join(",")}` };
  }
  return { ok: true, meta: result.data };
}

export type BodyKind = "wav" | "transcript";

/** Which body a POST /api/card carries, from its Content-Type. */
export function bodyKindOf(contentType: string | null | undefined): BodyKind | null {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return "wav";
  if (type === "text/plain") return "transcript";
  return null;
}

// Event stream

export const StageData = z.object({
  name: StageName,
  ms: z.number().nonnegative().optional(), // server ms since the request arrived
});
export type StageData = z.infer<typeof StageData>;

export const TokenUsage = z.object({
  inputTokens: z.number().nonnegative().optional(),
  cachedTokens: z.number().nonnegative().optional(),
  audioTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  audioSeconds: z.number().nonnegative().optional(), // Voice Transcribe bills audio time
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const ServerTiming = z.object({
  totalMs: z.number().nonnegative(), // request arrival to card event
  firstTokenMs: z.number().nonnegative().optional(), // request arrival to the first answer token
  asrMs: z.number().nonnegative().optional(), // Route A transcription time
  fallbackAtMs: z.number().nonnegative().optional(), // when Auto switched to Route A
  bytes: z.number().int().nonnegative(), // body bytes received
});
export type ServerTiming = z.infer<typeof ServerTiming>;

/** The meta fields the server writes. The client adds the rest with toCard. */
export const ServerCardMeta = z.object({
  route: z.enum(["open_weights", "meta_api", "mock"]),
  model: z.string(),
  fallbackFrom: z.literal("open_weights").optional(),
  fallbackCause: ProviderFailure.optional(),
  transcript: z.string().optional(),
  unformatted: z.literal(true).optional(),
  parse: ParseQuality,
  timing: ServerTiming,
  usage: TokenUsage.optional(),
});
export type ServerCardMeta = z.infer<typeof ServerCardMeta>;

/** The Card without the client-side meta fields (ux-spec 2-6). */
export const WireCard = CardBody.extend({ meta: ServerCardMeta });
export type WireCard = z.infer<typeof WireCard>;

export const ErrorData = z.object({
  code: ErrorCode,
  retryable: z.boolean(),
  stored: z.literal(false),
  route: LiveRoute.optional(), // the last live route tried
  cause: ProviderFailure.optional(),
  retryAfterSec: z.number().int().positive().optional(),
});
export type ErrorData = z.infer<typeof ErrorData>;

export const DoneData = z.object({});
export type DoneData = z.infer<typeof DoneData>;

export const STREAM_EVENT_NAMES = ["stage", "card", "error", "done"] as const;
export type StreamEventName = (typeof STREAM_EVENT_NAMES)[number];

export type StreamEvent =
  | { event: "stage"; data: StageData }
  | { event: "card"; data: WireCard }
  | { event: "error"; data: ErrorData }
  | { event: "done"; data: DoneData };

const EVENT_DATA = { stage: StageData, card: WireCard, error: ErrorData, done: DoneData } as const;

/** One event in text/event-stream framing. data is single-line JSON. */
export function encodeEvent(ev: StreamEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

export function encodeEventBytes(ev: StreamEvent): Uint8Array {
  return textEncoder.encode(encodeEvent(ev));
}

export type ParsedEvent =
  | { ok: true; event: StreamEvent }
  | { ok: false; name: string; reason: "unknown_event" | "bad_json" | "invalid" };

/** Validates one event's data against its schema. Unknown event names are reported, not thrown. */
export function parseStreamEvent(name: string, data: string): ParsedEvent {
  if (!(STREAM_EVENT_NAMES as readonly string[]).includes(name)) return { ok: false, name, reason: "unknown_event" };
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { ok: false, name, reason: "bad_json" };
  }
  const result = EVENT_DATA[name as StreamEventName].safeParse(json);
  if (!result.success) return { ok: false, name, reason: "invalid" };
  return { ok: true, event: { event: name, data: result.data } as StreamEvent };
}

export type InvalidEventHandler = (info: { name: string; reason: "bad_json" | "invalid" }) => void;

export interface EventStreamParser {
  push(text: string): void;
  end(): void;
}

/** Incremental text/event-stream parser. Unknown events are skipped for forward compatibility. */
export function createEventStreamParser(
  onEvent: (ev: StreamEvent) => void,
  onInvalid?: InvalidEventHandler,
): EventStreamParser {
  let buffer = "";
  let name = "";
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) {
      const parsed = parseStreamEvent(name || "message", data.join("\n"));
      if (parsed.ok) onEvent(parsed.event);
      else if (parsed.reason !== "unknown_event") onInvalid?.({ name: parsed.name, reason: parsed.reason });
    }
    name = "";
    data = [];
  };

  const line = (text: string) => {
    if (text === "") return dispatch();
    if (text.startsWith(":")) return; // comment or keep-alive
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  };

  return {
    push(text: string) {
      buffer += text;
      for (;;) {
        const lf = buffer.indexOf("\n");
        const cr = buffer.indexOf("\r");
        if (lf < 0 && cr < 0) break;
        let end: number;
        let skip: number;
        if (cr >= 0 && (lf < 0 || cr < lf)) {
          if (cr === buffer.length - 1) break; // a CR LF pair may be split across chunks
          end = cr;
          skip = buffer[cr + 1] === "\n" ? 2 : 1;
        } else {
          end = lf;
          skip = 1;
        }
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + skip);
      }
    },
    end() {
      if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
      if (buffer !== "") line(buffer);
      buffer = "";
      dispatch();
    },
  };
}

/** Reads a fetch body as typed events. Cancels the body if the consumer stops early. */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  onInvalid?: InvalidEventHandler,
): AsyncGenerator<StreamEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const queue: StreamEvent[] = [];
  const parser = createEventStreamParser((ev) => queue.push(ev), onInvalid);
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      while (queue.length > 0) yield queue.shift() as StreamEvent;
    }
    finished = true;
    parser.push(decoder.decode());
    parser.end();
    while (queue.length > 0) yield queue.shift() as StreamEvent;
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** True when a /api/card response carries the event stream (it does even for most errors). */
export function isEventStream(res: Pick<Response, "headers">): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream");
}

// Errors

export type ErrorAction = "retry" | "retry_or_other_route" | "try_sample" | "check_source" | "reload" | "none";

export interface ErrorInfo {
  retryable: boolean;
  httpStatus: number; // used when the error is known before the stream starts
  key: `error.${ErrorCode}`; // string key for local copy tables
  action: ErrorAction;
}

export const ERROR_INFO: Readonly<Record<ErrorCode, ErrorInfo>> = {
  bad_request: { retryable: false, httpStatus: 400, key: "error.bad_request", action: "reload" },
  bad_audio: { retryable: false, httpStatus: 400, key: "error.bad_audio", action: "check_source" },
  too_large: { retryable: false, httpStatus: 413, key: "error.too_large", action: "none" },
  rate_limited: { retryable: true, httpStatus: 429, key: "error.rate_limited", action: "try_sample" },
  daily_cap: { retryable: false, httpStatus: 503, key: "error.daily_cap", action: "try_sample" },
  live_off: { retryable: false, httpStatus: 503, key: "error.live_off", action: "try_sample" },
  not_configured: { retryable: false, httpStatus: 503, key: "error.not_configured", action: "try_sample" },
  mock_refused: { retryable: false, httpStatus: 403, key: "error.mock_refused", action: "none" },
  timeout: { retryable: true, httpStatus: 504, key: "error.timeout", action: "retry_or_other_route" },
  provider_error: { retryable: true, httpStatus: 502, key: "error.provider_error", action: "retry_or_other_route" },
  server_error: { retryable: true, httpStatus: 500, key: "error.server_error", action: "retry" },
  offline: { retryable: true, httpStatus: 0, key: "error.offline", action: "retry" },
  network: { retryable: true, httpStatus: 0, key: "error.network", action: "retry" },
  aborted: { retryable: false, httpStatus: 0, key: "error.aborted", action: "none" },
};

/** English copy. Says what happened and whether anything left. The action button carries the next step. */
export const ERROR_COPY_EN: Readonly<Record<ErrorCode, string>> = {
  bad_request: "The server couldn't read that request. Catch Up saved nothing.",
  bad_audio: "That clip wasn't usable audio. Catch Up saved nothing.",
  too_large: "That clip is longer than 2 minutes. Nothing was sent to a model.",
  rate_limited: "Live cards are paused for now. Samples show saved real cards.",
  daily_cap: "Live cards are paused for now. Samples show saved real cards.",
  live_off: "Live cards are paused for now. Samples show saved real cards.",
  not_configured: "Live cards aren't set up on this server yet. Nothing was sent to a model.",
  mock_refused: "Mock cards are off on this server. Nothing was sent to a model.",
  timeout: "That took too long. Catch Up saved nothing.",
  provider_error: "The model service returned an error. Catch Up saved nothing.",
  server_error: "Something went wrong on Catch Up's server. Catch Up saved nothing.",
  offline: "You're offline. Nothing was sent. Your clip stays in memory for 2 minutes.",
  network: "Couldn't reach Catch Up's server. Your clip stays in memory for 2 minutes.",
  aborted: "Cancelled. Catch Up saved nothing.",
};

export const ERROR_ACTION_LABELS_EN: Readonly<Record<ErrorAction, readonly string[]>> = {
  retry: ["Retry"],
  retry_or_other_route: ["Retry", "Use the other route"],
  try_sample: ["Try a sample"],
  check_source: ["Check source"],
  reload: ["Reload"],
  none: [],
};

/** UI text for each stage (ux-spec 2-6). */
export const STAGE_COPY_EN: Readonly<Record<StageName, string>> = {
  received: "Listening back",
  writing: "Writing your card",
  fallback: "Trying the backup route (Meta Model API)",
};

export function errorData(
  code: ErrorCode,
  extra: Partial<Pick<ErrorData, "route" | "cause" | "retryAfterSec">> = {},
): ErrorData {
  return { code, retryable: ERROR_INFO[code].retryable, stored: false, ...extra };
}

/** A complete response for an error found before streaming starts. Body is an error event then done. */
export function errorEventResponse(
  code: ErrorCode,
  extra: Partial<Pick<ErrorData, "route" | "cause" | "retryAfterSec">> = {},
): Response {
  const data = errorData(code, extra);
  const headers: Record<string, string> = { ...SSE_HEADERS };
  if (data.retryAfterSec !== undefined) headers["Retry-After"] = String(data.retryAfterSec);
  const body = encodeEvent({ event: "error", data }) + encodeEvent({ event: "done", data: {} });
  const status = ERROR_INFO[code].httpStatus || 500;
  return new Response(body, { status, headers });
}

/** Maps a non-stream HTTP failure (for example Vercel's own 413) to an error code. */
export function errorCodeFromStatus(status: number): ErrorCode {
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  if (status === 504) return "timeout";
  if (status >= 500) return "server_error";
  return "bad_request";
}

/** Maps the last provider failure to the error the user sees. */
export function errorCodeFromFailure(failure: ProviderFailure): ErrorCode {
  switch (failure) {
    case "timeout":
    case "no_token":
      return "timeout";
    case "not_configured":
      return "not_configured";
    case "aborted":
      return "aborted";
    default:
      return "provider_error";
  }
}

// GET /api/health

export const HealthResponse = z.object({
  ok: z.literal(true),
  v: z.literal(PROTOCOL_VERSION),
  live: z.boolean(), // live model calls are allowed right now
  paused: z.enum(["live_off", "daily_cap"]).nullable(),
  defaultRoute: RoutePreference, // CATCHUP_ROUTE, applied when a press asks for auto
  mock: z.boolean(), // the mock route is allowed here (dev and tests only)
  routes: z.object({
    open_weights: z.object({ configured: z.boolean(), model: z.string(), provider: z.string() }),
    meta_api: z.object({ configured: z.boolean(), model: z.string(), provider: z.string() }),
  }),
  limits: z.object({
    maxBodyBytes: z.number().int().positive(),
    maxClipSec: z.number().positive(),
    perHour: z.number().int().nonnegative(),
    hardCapMs: z.number().int().positive(),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// WAV body

export const WAV_PROBLEMS = [
  "too_small",
  "not_riff",
  "not_wave",
  "no_fmt",
  "no_data",
  "not_pcm",
  "not_mono",
  "not_16bit",
  "wrong_rate",
  "too_short",
  "too_long",
] as const;
export type WavProblem = (typeof WAV_PROBLEMS)[number];

export interface WavFormat {
  formatTag: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  seconds: number;
}

export type WavInspection = ({ ok: true } & WavFormat) | { ok: false; problem: WavProblem };

/** Raw body bytes in any form (ArrayBuffer, Uint8Array, Node Buffer, DataView). */
export type BinaryInput = ArrayBufferLike | ArrayBufferView;

function asBytes(input: BinaryInput): Uint8Array {
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

/** Reads a RIFF WAV header without copying the samples. Checks structure only. */
export function inspectWav(input: BinaryInput): WavInspection {
  const bytes = asBytes(input);
  if (bytes.byteLength < LIMITS.wavHeaderBytes) return { ok: false, problem: "too_small" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF") return { ok: false, problem: "not_riff" };
  if (ascii(bytes, 8, 4) !== "WAVE") return { ok: false, problem: "not_wave" };
  let fmt: Omit<WavFormat, "dataOffset" | "dataBytes" | "seconds"> | null = null;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) return { ok: false, problem: "no_fmt" };
      let formatTag = view.getUint16(body, true);
      if (formatTag === 0xfffe && size >= 26 && body + 26 <= bytes.byteLength) {
        formatTag = view.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      }
      fmt = {
        formatTag,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt) return { ok: false, problem: "no_fmt" };
      const dataBytes = Math.min(size, bytes.byteLength - body);
      const frameBytes = fmt.channels * (fmt.bitsPerSample / 8);
      const seconds = fmt.sampleRate > 0 && frameBytes > 0 ? dataBytes / (fmt.sampleRate * frameBytes) : 0;
      return { ok: true, ...fmt, dataOffset: body, dataBytes, seconds };
    }
    pos = body + size + (size % 2);
  }
  return { ok: false, problem: fmt ? "no_data" : "no_fmt" };
}

export type ClipCheck = { ok: true; wav: WavFormat } | { ok: false; code: "bad_audio" | "too_large"; problem: WavProblem };

/** Accepts only 16 kHz mono 16-bit PCM between minClipSec and maxClipSec. */
export function checkClipWav(input: BinaryInput): ClipCheck {
  const info = inspectWav(input);
  if (!info.ok) return { ok: false, code: "bad_audio", problem: info.problem };
  if (info.formatTag !== 1) return { ok: false, code: "bad_audio", problem: "not_pcm" };
  if (info.channels !== LIMITS.channels) return { ok: false, code: "bad_audio", problem: "not_mono" };
  if (info.bitsPerSample !== LIMITS.bitsPerSample) return { ok: false, code: "bad_audio", problem: "not_16bit" };
  if (info.sampleRate !== LIMITS.sampleRate) return { ok: false, code: "bad_audio", problem: "wrong_rate" };
  if (info.seconds < LIMITS.minClipSec) return { ok: false, code: "bad_audio", problem: "too_short" };
  if (info.seconds > LIMITS.maxClipSec) return { ok: false, code: "too_large", problem: "too_long" };
  const { ok: _ok, ...wav } = info;
  void _ok;
  return { ok: true, wav };
}

// Time

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Local ISO time with offset, for example 2026-11-02T10:42:40.123-05:00. */
export function toLocalIso(epochMs: number, offsetMinutes: number = -new Date(epochMs).getTimezoneOffset()): string {
  const local = new Date(epochMs + offsetMinutes * 60_000);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `.${pad(local.getUTCMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Weekday of the local date written in an ISO string, or null when it has no date. */
export function weekdayOfIso(iso: string): (typeof WEEKDAYS)[number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  if (!m) return null;
  return WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
}

// Client side card assembly

/** The meta fields only the client knows. */
export interface ClientCardMeta {
  id: string;
  pressedAt: string;
  windowSec: WindowSec;
  sentSec: number;
  cardLang: CardLang;
  source: Source;
  ms: CardTimings;
  bytesSent: number;
}

/** Joins a wire card with the client's meta into a full Card. Server-only extras are dropped. */
export function toCard(wire: WireCard, client: ClientCardMeta): Card {
  const { meta: server, ...body } = wire;
  const meta: CardMeta = {
    id: client.id,
    pressedAt: client.pressedAt,
    windowSec: client.windowSec,
    sentSec: client.sentSec,
    cardLang: client.cardLang,
    source: client.source,
    route: server.route,
    model: server.model,
    ms: client.ms,
    bytesSent: client.bytesSent,
  };
  if (server.fallbackFrom) meta.fallbackFrom = server.fallbackFrom;
  if (server.transcript !== undefined) meta.transcript = server.transcript;
  if (server.unformatted) meta.unformatted = true;
  return { ...body, meta };
}
