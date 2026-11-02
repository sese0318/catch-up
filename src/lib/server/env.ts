// Typed server settings. Server lane. Server only. Never log or return the keys.
import type { ServerEnv } from "../providers/types";

/**
 * Reads ENV_KEYS with ENV_DEFAULTS. Empty strings count as unset. allowMock is true only when
 * ALLOW_MOCK is 1 and NODE_ENV is not production. LIVE_ENABLED is on unless set to 0 or false.
 */
export function readServerEnv(source: Readonly<Record<string, string | undefined>> = process.env): ServerEnv {
  void source;
  throw new Error("not implemented");
}
