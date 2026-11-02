// Provider contract for the server lane (src/lib/providers, src/lib/server, src/app/api).
// Server only. Keys are read from process.env on the server and never reach the browser.
import type { CardBody } from "../card/schema";
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
  model: string; // what served the card, used as meta.model
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

/** Typed server settings, read by readServerEnv in src/lib/server/env.ts. */
export interface ServerEnv {
  baseten: {
    apiKey: string | null;
    baseUrl: string;
    model: string;
    modelFallback: string | null; // tried once when model returns 404
    maxTokens: number;
    temperature: number | null; // null leaves it out of the request
    topK: number | null; // null leaves it out, -1 disables top-k
  };
  meta: {
    apiKey: string | null;
    baseUrl: string;
    cardModel: string;
    asrModel: string;
    maxCompletionTokens: number;
  };
  routePolicy: RoutePreference; // CATCHUP_ROUTE, used when a press asks for auto
  liveEnabled: boolean; // LIVE_ENABLED kill switch
  allowMock: boolean; // ALLOW_MOCK is 1 and NODE_ENV is not production
  ratePerHour: number; // presses per client IP per hour, in memory
  dailyCap: number; // live presses per server instance per UTC day
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
  BASETEN_MODEL_FALLBACK: "meta-models/muse-spark-open",
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

/** Injection points for handleCardRequest, used by tests and by the eval runner in process. */
export interface CardHandlerDeps {
  env?: ServerEnv;
  providers?: Partial<Record<ProviderId, CardProvider>>;
  now?: () => number;
  log?: (entry: PressLogEntry) => void;
  /** Rate limit key. Defaults to the first x-forwarded-for address. */
  clientKey?: (req: Request) => string;
}

export interface HealthHandlerDeps {
  env?: ServerEnv;
  providers?: Partial<Record<ProviderId, CardProvider>>;
}
