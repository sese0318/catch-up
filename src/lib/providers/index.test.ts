import { describe, expect, it, vi } from "vitest";

vi.mock("../card/parse", async () => (await import("../server/test-support")).cardParseFake);
vi.mock("../card/prompt", async () => (await import("../server/test-support")).cardPromptFake);
vi.mock("../card/fixtures", async () => (await import("../server/test-support")).cardFixturesFake);

import { fakeProvider, makeWav, okResult, testEnv, testMeta } from "../server/test-support";
import { createMockProvider, createProviders, isMockProvider, planRoutes, MOCK_MODEL } from "./index";
import { MOCK_TIMELINE } from "./mock";
import { isProviderError, type CardProvider, type ProviderId, type ProviderRunInput, type ServerEnv } from "./types";

function providers(configured: Partial<Record<ProviderId, boolean>>, env: ServerEnv): Record<ProviderId, CardProvider> {
  const make = (id: ProviderId) => fakeProvider(id, async () => okResult(id), { configured: configured[id] ?? true });
  return { open_weights: make("open_weights"), meta_api: make("meta_api"), mock: createMockProvider(env) };
}

describe("planRoutes", () => {
  it("runs the configured routes in Auto order, Route B first, not pinned", () => {
    const env = testEnv();
    expect(planRoutes("auto", env, providers({}, env))).toEqual({ ok: true, routes: ["open_weights", "meta_api"], pinned: false });
    expect(planRoutes("auto", env, providers({ open_weights: false }, env))).toEqual({ ok: true, routes: ["meta_api"], pinned: false });
    expect(planRoutes("auto", env, providers({ meta_api: false }, env))).toEqual({ ok: true, routes: ["open_weights"], pinned: false });
    expect(planRoutes("auto", env, providers({ open_weights: false, meta_api: false }, env))).toEqual({ ok: false, code: "not_configured" });
  });

  it("pins a named route, from the press or from CATCHUP_ROUTE", () => {
    const env = testEnv();
    expect(planRoutes("meta_api", env, providers({}, env))).toEqual({ ok: true, routes: ["meta_api"], pinned: true });
    expect(planRoutes("open_weights", env, providers({ open_weights: false }, env))).toEqual({ ok: false, code: "not_configured" });
    const policy = testEnv({ routePolicy: "open_weights" });
    expect(planRoutes("auto", policy, providers({}, policy))).toEqual({ ok: true, routes: ["open_weights"], pinned: true });
  });

  it("stops live routes with the kill switch", () => {
    const env = testEnv({ liveEnabled: false });
    expect(planRoutes("auto", env, providers({}, env))).toEqual({ ok: false, code: "live_off" });
    expect(planRoutes("meta_api", env, providers({}, env))).toEqual({ ok: false, code: "live_off" });
  });

  it("allows mock only with allowMock, and mock ignores the kill switch", () => {
    const off = testEnv();
    expect(planRoutes("mock", off, providers({}, off))).toEqual({ ok: false, code: "mock_refused" });
    const on = testEnv({ allowMock: true, liveEnabled: false });
    expect(planRoutes("mock", on, providers({}, on))).toEqual({ ok: true, routes: ["mock"], pinned: true });
    const policy = testEnv({ routePolicy: "mock" });
    expect(planRoutes("auto", policy, providers({}, policy))).toEqual({ ok: false, code: "mock_refused" });
  });
});

describe("createProviders", () => {
  it("builds one provider per id from env, configured by its key", () => {
    const keyless = createProviders(testEnv({ baseten: { apiKey: null }, meta: { apiKey: null } }));
    expect(Object.keys(keyless).sort()).toEqual(["meta_api", "mock", "open_weights"]);
    expect(keyless.open_weights.isConfigured()).toBe(false);
    expect(keyless.meta_api.isConfigured()).toBe(false);
    expect(keyless.mock.isConfigured()).toBe(false);
    const keyed = createProviders(testEnv({ allowMock: true }));
    expect(keyed.open_weights.isConfigured()).toBe(true);
    expect(keyed.meta_api.isConfigured()).toBe(true);
    expect(keyed.mock.isConfigured()).toBe(true);
    expect(isMockProvider(keyed.mock)).toBe(true);
    expect(keyed.mock.modelLabel()).toBe(MOCK_MODEL);
  });
});

describe("mock provider", () => {
  const run = (env: ServerEnv, meta = testMeta({ route: "mock" }), onStage = vi.fn()) =>
    createMockProvider(env, { timeScale: 0 }).run({
      wav: makeWav(1),
      transcript: null,
      meta,
      signal: new AbortController().signal,
      onStage,
    } satisfies ProviderRunInput);

  it("serves the fixture in the card language with a writing stage", async () => {
    const onStage = vi.fn();
    const result = await run(testEnv({ allowMock: true }), testMeta({ route: "mock", cardLang: "zh", mock: { mode: "ok", fixture: "room" } }), onStage);
    expect(result.body.summary[0]).toBe("Mock room card in zh");
    expect(result.model).toBe(MOCK_MODEL);
    expect(onStage).toHaveBeenCalledTimes(1);
  });

  it("refuses when mock is not allowed, as in production", async () => {
    const error = await run(testEnv()).catch((e: unknown) => e);
    expect(isProviderError(error) && error.code).toBe("not_configured");
  });

  it("fails in error mode and returns broken JSON in badjson mode", async () => {
    const env = testEnv({ allowMock: true });
    const failed = await run(env, testMeta({ route: "mock", mock: { mode: "error" } })).catch((e: unknown) => e);
    expect(isProviderError(failed) && failed.code).toBe("http");
    const broken = await run(env, testMeta({ route: "mock", mock: { mode: "badjson" } })).catch((e: unknown) => e);
    expect(isProviderError(broken) && broken.code).toBe("bad_json");
    expect(isProviderError(broken) && broken.raw).toMatch(/^\{"heard"/);
  });

  it("follows the ux-spec timeline of 0.3 s, 1.2 s and 2.8 s", () => {
    expect(MOCK_TIMELINE.ok).toEqual({ receivedMs: 300, writingMs: 1_200, endMs: 2_800 });
    const mock = createMockProvider(testEnv({ allowMock: true }));
    expect(mock.receivedDelayMs(testMeta({ route: "mock" }))).toBe(300);
    for (const timeline of Object.values(MOCK_TIMELINE)) expect(timeline.endMs).toBeLessThan(19_000);
  });
});
