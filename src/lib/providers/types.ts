// Provider contract for the server lane (src/lib/providers, src/lib/server, src/app/api).
// Server only. Keys are read from process.env on the server and never reach the browser.
import type { CardBody, CardLang, META_RESPONSE_FORMAT } from "../card/schema";
import {
  LIMITS,
  PROVIDER_FAILURES,
  type ErrorCode,
  type ParseQuality,
  type PressMeta,
  type ProviderFailure,
  type RoutePreference,
  type TokenUsage,
} from "../protocol";

export const PROVIDER_IDS = ["open_weights", "meta_api", "mock"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderErrorCode = ProviderFailure;
export const PROVIDER_ERROR_CODES = PROVIDER_FAILURES;

export interface ProviderStage {
  name: "writing"; // the first answer token arrived (or the full answer, when not streaming)
  atMs: number; // ms since run() started
}

export interface ProviderRunInput {
  /** 16 kHz mono PCM16 WAV, already accepted by checkClipWav. Null when transcript is set. */
  wav: Uint8Array | null;
  /** Route A only. An earlier transcript reused for a language redo, so transcription is skipped. */
  transcript: string | null;
  meta: PressMeta;
  /** Fires on client disconnect, on the Auto no-token deadline and on the hard cap. */
  signal: AbortSignal;
  /** Call once, at the first answer token. */
  onStage: (stage: ProviderStage) => void;
}

export interface ProviderTimings {
  totalMs: number;
  firstTokenMs?: number;
  asrMs?: number;
}

export interface ProviderResult {
  body: CardBody; // parsed and clamped with parseCardText
  model: string; // what served the card, used as meta.model (see ServerCardMeta.model)
  parse: Exclude<ParseQuality, "unformatted">;
  transcript?: string; // Route A
  timings: ProviderTimings;
  usage?: TokenUsage;
}

export interface CardProvider {
  readonly id: ProviderId;
  /** True when its key (or ALLOW_MOCK for mock) is present. Never throws. */
  isConfigured(): boolean;
  /** Model id or label for health and receipts, for example muse-voice-transcribe-1.0 + muse-spark-1.3. */
  modelLabel(): string;
  /** Resolves with a valid card or rejects with a ProviderError. */
  run(input: ProviderRunInput): Promise<ProviderResult>;
}

export interface ProviderErrorOptions {
  status?: number;
  retryAfterSec?: number;
  raw?: string;
  transcript?: string;
  model?: string;
  cause?: unknown;
}

/** The only error a provider throws. Its message never contains audio, transcripts or model text. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: ProviderId;
  readonly status?: number;
  readonly retryAfterSec?: number;
  /** Model text kept only to build an Unformatted card in this request. Never log it. */
  readonly raw?: string;
  /** Route A transcript when transcription worked. Never log it. */
  readonly transcript?: string;
  readonly model?: string;

  constructor(code: ProviderErrorCode, provider: ProviderId, options: ProviderErrorOptions = {}) {
    super(`${provider} failed with ${code}${options.status ? ` (HTTP ${options.status})` : ""}`, {
      cause: options.cause,
    });
    this.name = "ProviderError";
    this.code = code;
    this.provider = provider;
    this.status = options.status;
    this.retryAfterSec = options.retryAfterSec;
    this.raw = options.raw;
    this.transcript = options.transcript;
    this.model = options.model;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Auto policy (ux-spec 2-4). A route pinned by the press or by CATCHUP_ROUTE never falls back. */
export const AUTO_POLICY = {
  order: ["open_weights", "meta_api"] as const, // configured routes only, Route B first
  noTokenFallbackMs: LIMITS.autoFallbackMs, // AUTO_FALLBACK_MS overrides it
  maxFallbacks: 1,
  serverDeadlineMs: LIMITS.hardCapMs - 1_000, // leaves time to stream the timeout error
  fallbackOn: ["http", "rate_limited", "timeout", "no_token", "bad_json", "refused", "length", "empty"] as const,
} as const;

// Route B. Baseten Chat Completions, Muse Spark Open hears the WAV directly.

/** Baseten's request schema is closed (additionalProperties false), so a Route B body has these fields only. */
export const BASETEN_BODY_FIELDS = [
  "model",
  "messages",
  "stream",
  "stream_options",
  "reasoning_effort",
  "max_tokens",
  "temperature",
  "top_k",
] as const;

export const ROUTE_B = {
  path: "/chat/completions",
  instructionRole: "system", // Baseten's role enum is system, user, assistant and tool, with no developer
  reasoningEffort: "low",
  audioDataUrlPrefix: "data:audio/wav;base64,",
  inputAudioRetryStatus: 400, // one retry with an input_audio part instead of audio_url
  // Dev only. A slug that answers 403 or 404 is remembered for the life of the server instance,
  // and later presses go straight to ServerEnv.baseten.modelFallback.
  slugFallbackStatuses: [403, 404],
  affinityHeader: "x-session-affinity", // carries PressMeta.sessionId and nothing else
} as const;

export type BasetenUserPart =
  | { type: "text"; text: string } // userText(), always first
  | { type: "audio_url"; audio_url: { url: string } } // ROUTE_B.audioDataUrlPrefix plus the base64 WAV
  | { type: "input_audio"; input_audio: { data: string; format: "wav" } }; // the 400 retry shape

/** The whole Route B body. temperature and top_k are left out when ServerEnv holds null for them. */
export interface BasetenChatBody {
  model: string;
  messages: [
    { role: typeof ROUTE_B.instructionRole; content: string }, // systemPrompt()
    { role: "user"; content: BasetenUserPart[] },
  ];
  stream: true;
  stream_options: { include_usage: true };
  reasoning_effort: typeof ROUTE_B.reasoningEffort;
  max_tokens: number;
  temperature?: number;
  top_k?: number;
}

// Route A. Muse Voice Transcribe, then muse-spark-1.3 on the transcript text.

/** Voice Transcribe file endpoint. Meta ignores unknown mode and field names silently, so use these. */
export const META_ASR = {
  path: "/asr/transcribe",
  requestPart: "request", // multipart JSON part holding MetaAsrRequest
  audioPart: "audio", // multipart file part holding the WAV
  audioFileName: "clip.wav",
  audioEncoding: "WAV", // required, no default
  mode: "PUSH_TO_TALK", // the clip is one turn, so a sentence cut by the press is kept
  accept: "application/json",
  maxKeywords: 20, // our own cap, not a documented limit
} as const;

/** languageBias takes language names, not codes. Unknown names are ignored silently, so gate 1 checks the Mandarin one. */
export const ASR_LANGUAGE_NAMES: Readonly<Record<CardLang, string>> = {
  en: "English",
  ja: "Japanese",
  zh: "Mandarin Chinese",
};

export interface MetaAsrRequest {
  model: string;
  audioEncoding: typeof META_ASR.audioEncoding;
  mode: typeof META_ASR.mode;
  languageBias: string[];
  keywords?: string[];
}

/** Route A card call body fields. No temperature, top_p, stop, n or penalties (Meta returns 400 or ignores them). */
export const META_CHAT_BODY_FIELDS = [
  "model",
  "messages",
  "stream",
  "stream_options",
  "reasoning_effort",
  "max_completion_tokens",
  "response_format",
] as const;

export const ROUTE_A = {
  chatPath: "/chat/completions",
  instructionRole: "developer", // Meta prefers developer over system
  reasoningEffort: "minimal",
} as const;

/** The whole Route A card body. The user message is userText() with the transcript, never audio. */
export interface MetaChatBody {
  model: string;
  messages: [{ role: typeof ROUTE_A.instructionRole; content: string }, { role: "user"; content: string }];
  stream: true;
  stream_options: { include_usage: true };
  reasoning_effort: typeof ROUTE_A.reasoningEffort;
  max_completion_tokens: number;
  response_format: typeof META_RESPONSE_FORMAT;
}

/** The PressMeta fields the transcription request uses. A decoded PressMeta fits as is. */
export interface AsrPressInput {
  meetingLang: CardLang;
  cardLang: CardLang;
  names: readonly string[];
  hint?: string;
}

/** languageBias for a press, the meeting language first, without repeats (ux-spec 2-4). */
export function asrLanguageBias(meta: Pick<AsrPressInput, "meetingLang" | "cardLang">): string[] {
  return [...new Set([ASR_LANGUAGE_NAMES[meta.meetingLang], ASR_LANGUAGE_NAMES[meta.cardLang]])];
}

const KEYWORD_SEPARATORS = /[,，、]/;

/** keywords for a press. The name forms, then the hint split on commas (also 、 and ，), trimmed, without repeats. */
export function asrKeywords(meta: Pick<AsrPressInput, "names" | "hint">): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...meta.names, ...(meta.hint ?? "").split(KEYWORD_SEPARATORS)]) {
    const word = raw.trim();
    const key = word.toLocaleLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length === META_ASR.maxKeywords) break;
  }
  return out;
}

/** The request part for POST /asr/transcribe. keywords is left out when there are none. */
export function buildAsrRequest(meta: AsrPressInput, model: string): MetaAsrRequest {
  const keywords = asrKeywords(meta);
  return {
    model,
    audioEncoding: META_ASR.audioEncoding,
    mode: META_ASR.mode,
    languageBias: asrLanguageBias(meta),
    ...(keywords.length > 0 ? { keywords } : {}),
  };
}

/** Contributor Services may train on inputs, and Terms 6.2 bans personal information there. */
export function isContributorModel(id: string): boolean {
  return /-contributor$/i.test(id.trim());
}

/** Typed server settings, read by readServerEnv in src/lib/server/env.ts. */
export interface ServerEnv {
  baseten: {
    apiKey: string | null;
    baseUrl: string;
    model: string; // BASETEN_MODEL, the hackathon slug in production and in the demo
    modelFallback: string | null; // dev only, tried on ROUTE_B.slugFallbackStatuses. Always null in production
    maxTokens: number;
    temperature: number | null; // null leaves it out of the request
    topK: number | null; // null leaves it out, -1 disables top-k
  };
  meta: {
    apiKey: string | null;
    baseUrl: string;
    cardModel: string; // never a -contributor id, readServerEnv keeps the default instead
    asrModel: string; // same rule
    maxCompletionTokens: number;
  };
  routePolicy: RoutePreference; // CATCHUP_ROUTE, used when a press asks for auto
  liveEnabled: boolean; // LIVE_ENABLED kill switch
  allowMock: boolean; // ALLOW_MOCK is 1 and NODE_ENV is not production
  ratePerHour: number; // live presses per client key per hour, in memory. 0 turns it off. Mock never counts
  dailyCap: number; // live presses per server instance per UTC day, at least 1. Mock never counts
  autoFallbackMs: number;
}

/** Every server env var. .env.example lists the same keys (checked by a test). */
export const ENV_KEYS = [
  "BASETEN_API_KEY",
  "BASETEN_BASE_URL",
  "BASETEN_MODEL",
  "BASETEN_MODEL_FALLBACK",
  "BASETEN_MAX_TOKENS",
  "BASETEN_TEMPERATURE",
  "BASETEN_TOP_K",
  "MODEL_API_KEY",
  "META_BASE_URL",
  "META_CARD_MODEL",
  "META_ASR_MODEL",
  "META_MAX_COMPLETION_TOKENS",
  "CATCHUP_ROUTE",
  "LIVE_ENABLED",
  "ALLOW_MOCK",
  "RATE_LIMIT_PER_HOUR",
  "DAILY_PRESS_CAP",
  "AUTO_FALLBACK_MS",
] as const;
export type EnvKey = (typeof ENV_KEYS)[number];

/** Never logged, printed, committed or sent to the browser. */
export const SECRET_ENV_KEYS = ["BASETEN_API_KEY", "MODEL_API_KEY"] as const;

export const ENV_DEFAULTS = {
  BASETEN_BASE_URL: "https://inference.baseten.co/v1",
  BASETEN_MODEL: "meta-models/muse-spark-open-1026",
  BASETEN_MODEL_FALLBACK: null, // set it only in .env.local, for example meta-models/muse-spark-open
  BASETEN_MAX_TOKENS: 2048,
  BASETEN_TEMPERATURE: 1.0,
  BASETEN_TOP_K: null,
  META_BASE_URL: "https://api.meta.ai/v1",
  META_CARD_MODEL: "muse-spark-1.3",
  META_ASR_MODEL: "muse-voice-transcribe-1.0",
  META_MAX_COMPLETION_TOKENS: 4000,
  CATCHUP_ROUTE: "auto",
  LIVE_ENABLED: true,
  ALLOW_MOCK: false,
  RATE_LIMIT_PER_HOUR: 30,
  DAILY_PRESS_CAP: 500,
  AUTO_FALLBACK_MS: LIMITS.autoFallbackMs,
} as const;

/** One line per press. Never audio, transcripts, card text, names, hints, IPs or keys. */
export interface PressLogEntry {
  at: string; // server ISO time
  status: "ok" | "error";
  route: ProviderId | null;
  model: string | null;
  fallback: boolean;
  cause?: ProviderFailure;
  code?: ErrorCode;
  parse?: ParseQuality;
  windowSec?: number;
  sentSec?: number;
  bytes: number;
  ms: { total: number; firstToken?: number; asr?: number };
}

/** The rate limit key off Vercel (local dev, a tunnel, in-process calls), and on Vercel without x-real-ip. */
export const LOCAL_CLIENT_KEY = "local";

/** Injection points for handleCardRequest, used by tests and by the eval runner in process. */
export interface CardHandlerDeps {
  /** Replaces readServerEnv(). The eval passes ratePerHour 0 so its live presses are never refused. */
  env?: ServerEnv;
  providers?: Partial<Record<ProviderId, CardProvider>>;
  now?: () => number;
  log?: (entry: PressLogEntry) => void;
  /** Rate limit key. Defaults to clientKeyOf in src/lib/server/where.ts. The eval passes one key per run. */
  clientKey?: (req: Request) => string;
}

export interface HealthHandlerDeps {
  env?: ServerEnv;
  providers?: Partial<Record<ProviderId, CardProvider>>;
}
