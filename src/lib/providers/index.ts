// Provider registry and route planning (ux-spec 2-4). Server lane. Server only.
// open_weights is Baseten Chat Completions with Muse Spark Open hearing the WAV as an audio_url
// data URL, a BasetenChatBody built with ROUTE_B. meta_api is Muse Voice Transcribe with
// buildAsrRequest and META_ASR, then muse-spark-1.3 with a MetaChatBody built with ROUTE_A and
// META_RESPONSE_FORMAT. mock serves mockCardBody with the timings of ux-spec 7 Modes 3.
import type { RoutePreference } from "../protocol";
import { createMetaApiProvider } from "./meta-api";
import { createMockProvider } from "./mock";
import { createOpenWeightsProvider } from "./open-weights";
import { AUTO_POLICY, type CardProvider, type ProviderId, type ServerEnv } from "./types";

export { createMetaApiProvider } from "./meta-api";
export { createMockProvider, isMockProvider, MOCK_MODEL } from "./mock";
export { createOpenWeightsProvider } from "./open-weights";

export type RoutePlan =
  | { ok: true; routes: ProviderId[]; pinned: boolean }
  | { ok: false; code: "not_configured" | "mock_refused" | "live_off" };

/** One provider per id, built from env. Never reads process.env directly. */
export function createProviders(env: ServerEnv): Record<ProviderId, CardProvider> {
  return {
    open_weights: createOpenWeightsProvider(env),
    meta_api: createMetaApiProvider(env),
    mock: createMockProvider(env),
  };
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
  const route = preference === "auto" ? env.routePolicy : preference;
  if (route === "mock") {
    return env.allowMock && providers.mock.isConfigured()
      ? { ok: true, routes: ["mock"], pinned: true }
      : { ok: false, code: "mock_refused" };
  }
  if (!env.liveEnabled) return { ok: false, code: "live_off" };
  if (route === "auto") {
    const routes = AUTO_POLICY.order.filter((id) => providers[id].isConfigured());
    return routes.length > 0 ? { ok: true, routes, pinned: false } : { ok: false, code: "not_configured" };
  }
  return providers[route].isConfigured() ? { ok: true, routes: [route], pinned: true } : { ok: false, code: "not_configured" };
}
