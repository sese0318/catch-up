// Provider registry and route planning (ux-spec 2-4). Server lane. Server only.
// open_weights is Baseten Chat Completions with Muse Spark Open hearing the WAV as an audio_url
// data URL. meta_api is Muse Voice Transcribe (PUSH_TO_TALK) then muse-spark-1.3 with
// META_RESPONSE_FORMAT. mock serves mockCardBody with the timings of ux-spec 7 Modes 3.
import type { RoutePreference } from "../protocol";
import type { CardProvider, ProviderId, ServerEnv } from "./types";

export type RoutePlan =
  | { ok: true; routes: ProviderId[]; pinned: boolean }
  | { ok: false; code: "not_configured" | "mock_refused" | "live_off" };

/** One provider per id, built from env. Never reads process.env directly. */
export function createProviders(env: ServerEnv): Record<ProviderId, CardProvider> {
  void env;
  throw new Error("not implemented");
}

/**
 * Resolves a press preference. auto defers to env.routePolicy. Policy auto means the configured
 * routes in AUTO_POLICY.order, not pinned. A named live route is pinned and never falls back.
 * mock needs env.allowMock (mock_refused otherwise) and ignores LIVE_ENABLED. Live routes need
 * env.liveEnabled (live_off otherwise) and a key (not_configured otherwise).
 */
export function planRoutes(
  preference: RoutePreference,
  env: ServerEnv,
  providers: Record<ProviderId, CardProvider>,
): RoutePlan {
  void preference;
  void env;
  void providers;
  throw new Error("not implemented");
}
