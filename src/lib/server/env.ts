// Typed server settings. Server lane. Server only. Never log or return the keys.
import { RoutePreference } from "../protocol";
import { AUTO_POLICY, ENV_DEFAULTS, isContributorModel, type EnvKey, type ServerEnv } from "../providers/types";

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Inclusive ranges. A number outside its range, or one that does not parse, uses the default. */
const RANGES = {
  BASETEN_MAX_TOKENS: [256, 262_144], // Baseten's schema maximum
  BASETEN_TEMPERATURE: [0, 2],
  BASETEN_TOP_K: [1, 100_000], // -1 is accepted too and turns top-k off
  META_MAX_COMPLETION_TOKENS: [256, 1_048_576], // the Muse Spark context window
  RATE_LIMIT_PER_HOUR: [0, 100_000], // 0 turns the per-client limit off
  DAILY_PRESS_CAP: [1, 1_000_000],
  AUTO_FALLBACK_MS: [1_000, AUTO_POLICY.serverDeadlineMs - 1_000], // leaves Route A time before the deadline
} as const;

/**
 * Reads ENV_KEYS with ENV_DEFAULTS. Empty strings count as unset, and numbers that do not parse or
 * fall out of range use the default. allowMock is true only when ALLOW_MOCK is 1 and NODE_ENV is not
 * production. LIVE_ENABLED is on unless set to 0 or false. baseten.modelFallback is always null when
 * NODE_ENV is production, so the deployed app and the demo never leave BASETEN_MODEL quietly.
 * META_CARD_MODEL and META_ASR_MODEL keep their defaults when set to an id that isContributorModel
 * flags. RATE_LIMIT_PER_HOUR 0 turns the per-client limit off, and DAILY_PRESS_CAP must be 1 or more.
 */
export function readServerEnv(source: EnvSource = process.env): ServerEnv {
  // Either source saying production is enough, so a custom source never turns mock on in production.
  const production = source.NODE_ENV === "production" || process.env.NODE_ENV === "production";

  const text = (key: EnvKey): string | null => {
    const value = source[key]?.trim();
    return value ? value : null;
  };

  const number = (key: Exclude<keyof typeof RANGES, "BASETEN_TOP_K">, fallback: number, integer: boolean): number => {
    const raw = text(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    const [min, max] = RANGES[key];
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) return fallback;
    return value;
  };

  const baseUrl = (key: EnvKey, fallback: string): string => {
    const raw = text(key);
    if (raw === null) return fallback;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    } catch {
      return fallback;
    }
    return raw.replace(/\/+$/, "");
  };

  // Contributor Services may train on inputs, and Terms 6.2 bans personal information there.
  const modelId = (key: EnvKey, fallback: string): string => {
    const raw = text(key);
    return raw !== null && !isContributorModel(raw) ? raw : fallback;
  };

  const topK = (): number | null => {
    const raw = text("BASETEN_TOP_K");
    if (raw === null) return ENV_DEFAULTS.BASETEN_TOP_K;
    const value = Number(raw);
    if (value === -1) return -1;
    const [min, max] = RANGES.BASETEN_TOP_K;
    return Number.isInteger(value) && value >= min && value <= max ? value : ENV_DEFAULTS.BASETEN_TOP_K;
  };

  const model = modelId("BASETEN_MODEL", ENV_DEFAULTS.BASETEN_MODEL);
  const fallbackSlug = text("BASETEN_MODEL_FALLBACK");
  const modelFallback =
    production || fallbackSlug === null || fallbackSlug === model || isContributorModel(fallbackSlug)
      ? ENV_DEFAULTS.BASETEN_MODEL_FALLBACK
      : fallbackSlug;

  const live = text("LIVE_ENABLED");
  const route = RoutePreference.safeParse(text("CATCHUP_ROUTE")?.toLowerCase());

  return {
    baseten: {
      apiKey: text("BASETEN_API_KEY"),
      baseUrl: baseUrl("BASETEN_BASE_URL", ENV_DEFAULTS.BASETEN_BASE_URL),
      model,
      modelFallback,
      maxTokens: number("BASETEN_MAX_TOKENS", ENV_DEFAULTS.BASETEN_MAX_TOKENS, true),
      temperature: number("BASETEN_TEMPERATURE", ENV_DEFAULTS.BASETEN_TEMPERATURE, false),
      topK: topK(),
    },
    meta: {
      apiKey: text("MODEL_API_KEY"),
      baseUrl: baseUrl("META_BASE_URL", ENV_DEFAULTS.META_BASE_URL),
      cardModel: modelId("META_CARD_MODEL", ENV_DEFAULTS.META_CARD_MODEL),
      asrModel: modelId("META_ASR_MODEL", ENV_DEFAULTS.META_ASR_MODEL),
      maxCompletionTokens: number("META_MAX_COMPLETION_TOKENS", ENV_DEFAULTS.META_MAX_COMPLETION_TOKENS, true),
    },
    routePolicy: route.success ? route.data : ENV_DEFAULTS.CATCHUP_ROUTE,
    liveEnabled: live === null ? ENV_DEFAULTS.LIVE_ENABLED : !/^(0|false)$/i.test(live),
    allowMock: !production && text("ALLOW_MOCK") === "1",
    ratePerHour: number("RATE_LIMIT_PER_HOUR", ENV_DEFAULTS.RATE_LIMIT_PER_HOUR, true),
    dailyCap: number("DAILY_PRESS_CAP", ENV_DEFAULTS.DAILY_PRESS_CAP, true),
    autoFallbackMs: number("AUTO_FALLBACK_MS", ENV_DEFAULTS.AUTO_FALLBACK_MS, true),
  };
}
