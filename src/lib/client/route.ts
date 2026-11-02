// Which route a press asks for, from Advanced settings, /api/health and the dev-only ?mock= param.
import type { LiveRoute } from "../card/schema";
import {
  HealthResponse,
  MOCK_FIXTURE_KINDS,
  MOCK_MODES,
  type MockFixtureKind,
  type MockMode,
  type MockSpec,
  type RoutePreference,
} from "../protocol";
import type { SettingsRoute } from "./settings";

/**
 * ?mock=1, ?mock=slow, ?mock=error or ?mock=badjson (ux-spec 7 Modes 3), plus ?fixture=you or a
 * fixture name as the mock value (?mock=unsure_number). Null when the page has no mock param.
 */
export function parseMockParam(search: string): MockSpec | null {
  const params = new URLSearchParams(search);
  if (!params.has("mock")) return null;
  const value = (params.get("mock") ?? "").trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off") return null;
  const isMode = (v: string): v is MockMode => (MOCK_MODES as readonly string[]).includes(v);
  const isFixture = (v: string): v is MockFixtureKind => (MOCK_FIXTURE_KINDS as readonly string[]).includes(v);
  const fixtureParam = (params.get("fixture") ?? "").trim().toLowerCase();
  const spec: MockSpec = { mode: isMode(value) ? value : "ok" };
  if (isFixture(value)) spec.fixture = value;
  else if (isFixture(fixtureParam)) spec.fixture = fixtureParam;
  return spec;
}

export type HealthView = { state: "loading" } | { state: "ok"; data: HealthResponse } | { state: "unavailable" };

export function parseHealth(json: unknown): HealthResponse | null {
  const parsed = HealthResponse.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export interface RoutePlan {
  route: RoutePreference;
  mock?: MockSpec;
  /** param for ?mock=, no_live when the server allows mock and has no live route (dev without keys). */
  mockReason: "param" | "no_live" | null;
}

export function liveRoutesConfigured(health: HealthView): LiveRoute[] {
  if (health.state !== "ok") return [];
  const out: LiveRoute[] = [];
  if (health.data.routes.open_weights.configured) out.push("open_weights");
  if (health.data.routes.meta_api.configured) out.push("meta_api");
  return out;
}

export function planRoute(route: SettingsRoute, health: HealthView, mockParam: MockSpec | null): RoutePlan {
  const mockAllowed = health.state !== "ok" || health.data.mock;
  if (mockParam && mockAllowed) return { route: "mock", mock: mockParam, mockReason: "param" };
  if (health.state === "ok" && health.data.mock && liveRoutesConfigured(health).length === 0) {
    return { route: "mock", mock: { mode: "ok" }, mockReason: "no_live" };
  }
  return { route, mockReason: null };
}

/**
 * The live route to offer after a failure, or null to hide that button. Only under Auto (in the
 * settings and on the server) and only when both routes are set up. A pinned route never switches,
 * so Open weights only never sends the held clip to the Meta Model API.
 */
export function otherRoute(failed: LiveRoute | undefined, plan: RoutePlan, health: HealthView): LiveRoute | null {
  if (plan.route !== "auto") return null;
  if (health.state !== "ok" || health.data.defaultRoute !== "auto") return null;
  const live = liveRoutesConfigured(health);
  if (live.length < 2) return null;
  if (failed === "meta_api") return "open_weights";
  return "meta_api"; // Auto starts on open weights, so the backup is the other route
}
