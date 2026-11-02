// Typed server settings. Server lane. Server only. Never log or return the keys.
import type { ServerEnv } from "../providers/types";

/**
 * Reads ENV_KEYS with ENV_DEFAULTS. Empty strings count as unset, and numbers that do not parse or
 * fall out of range use the default. allowMock is true only when ALLOW_MOCK is 1 and NODE_ENV is not
 * production. LIVE_ENABLED is on unless set to 0 or false. baseten.modelFallback is always null when
 * NODE_ENV is production, so the deployed app and the demo never leave BASETEN_MODEL quietly.
 * META_CARD_MODEL and META_ASR_MODEL keep their defaults when set to an id that isContributorModel
 * flags. RATE_LIMIT_PER_HOUR 0 turns the per-client limit off, and DAILY_PRESS_CAP must be 1 or more.
 */
export function readServerEnv(source: Readonly<Record<string, string | undefined>> = process.env): ServerEnv {
  void source;
  throw new Error("not implemented");
}
