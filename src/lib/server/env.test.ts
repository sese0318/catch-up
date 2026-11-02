import { describe, expect, it } from "vitest";
import { AUTO_POLICY, ENV_DEFAULTS } from "../providers/types";
import { readServerEnv } from "./env";

describe("readServerEnv", () => {
  it("uses the defaults when nothing is set, with no keys and mock off", () => {
    const env = readServerEnv({});
    expect(env).toEqual({
      baseten: {
        apiKey: null,
        baseUrl: ENV_DEFAULTS.BASETEN_BASE_URL,
        model: ENV_DEFAULTS.BASETEN_MODEL,
        modelFallback: null,
        maxTokens: ENV_DEFAULTS.BASETEN_MAX_TOKENS,
        temperature: ENV_DEFAULTS.BASETEN_TEMPERATURE,
        topK: null,
      },
      meta: {
        apiKey: null,
        baseUrl: ENV_DEFAULTS.META_BASE_URL,
        cardModel: ENV_DEFAULTS.META_CARD_MODEL,
        asrModel: ENV_DEFAULTS.META_ASR_MODEL,
        maxCompletionTokens: ENV_DEFAULTS.META_MAX_COMPLETION_TOKENS,
      },
      routePolicy: "auto",
      liveEnabled: true,
      allowMock: false,
      ratePerHour: 30,
      dailyCap: 500,
      autoFallbackMs: 8_000,
    });
  });

  it("counts empty and blank strings as unset", () => {
    const env = readServerEnv({
      BASETEN_API_KEY: "  ",
      MODEL_API_KEY: "",
      BASETEN_MODEL: " ",
      BASETEN_MAX_TOKENS: "",
      LIVE_ENABLED: "",
      CATCHUP_ROUTE: "",
    });
    expect(env.baseten.apiKey).toBeNull();
    expect(env.meta.apiKey).toBeNull();
    expect(env.baseten.model).toBe(ENV_DEFAULTS.BASETEN_MODEL);
    expect(env.baseten.maxTokens).toBe(2048);
    expect(env.liveEnabled).toBe(true);
    expect(env.routePolicy).toBe("auto");
  });

  it("reads keys, models, base URLs and numbers, trimming spaces and trailing slashes", () => {
    const env = readServerEnv({
      BASETEN_API_KEY: " b10_key ",
      MODEL_API_KEY: "LLM_1_secret",
      BASETEN_BASE_URL: "http://localhost:8787/v1/",
      META_BASE_URL: "https://api.meta.ai/v1",
      BASETEN_MAX_TOKENS: "4096",
      BASETEN_TEMPERATURE: "0.3",
      BASETEN_TOP_K: "-1",
      META_MAX_COMPLETION_TOKENS: "3000",
      CATCHUP_ROUTE: "Meta_API",
      RATE_LIMIT_PER_HOUR: "12",
      DAILY_PRESS_CAP: "40",
      AUTO_FALLBACK_MS: "5000",
    });
    expect(env.baseten.apiKey).toBe("b10_key");
    expect(env.meta.apiKey).toBe("LLM_1_secret");
    expect(env.baseten.baseUrl).toBe("http://localhost:8787/v1");
    expect(env.baseten.maxTokens).toBe(4096);
    expect(env.baseten.temperature).toBe(0.3);
    expect(env.baseten.topK).toBe(-1);
    expect(env.meta.maxCompletionTokens).toBe(3000);
    expect(env.routePolicy).toBe("meta_api");
    expect(env.ratePerHour).toBe(12);
    expect(env.dailyCap).toBe(40);
    expect(env.autoFallbackMs).toBe(5000);
  });

  it("falls back to the defaults for bad or out of range numbers and URLs", () => {
    const env = readServerEnv({
      BASETEN_MAX_TOKENS: "lots",
      BASETEN_TEMPERATURE: "7",
      BASETEN_TOP_K: "0",
      META_MAX_COMPLETION_TOKENS: "12.5",
      RATE_LIMIT_PER_HOUR: "-3",
      DAILY_PRESS_CAP: "0",
      AUTO_FALLBACK_MS: "60000",
      BASETEN_BASE_URL: "not a url",
      META_BASE_URL: "ftp://api.meta.ai/v1",
      CATCHUP_ROUTE: "fastest",
    });
    expect(env.baseten.maxTokens).toBe(ENV_DEFAULTS.BASETEN_MAX_TOKENS);
    expect(env.baseten.temperature).toBe(ENV_DEFAULTS.BASETEN_TEMPERATURE);
    expect(env.baseten.topK).toBeNull();
    expect(env.meta.maxCompletionTokens).toBe(ENV_DEFAULTS.META_MAX_COMPLETION_TOKENS);
    expect(env.ratePerHour).toBe(ENV_DEFAULTS.RATE_LIMIT_PER_HOUR);
    expect(env.dailyCap).toBe(ENV_DEFAULTS.DAILY_PRESS_CAP);
    expect(env.autoFallbackMs).toBe(ENV_DEFAULTS.AUTO_FALLBACK_MS);
    expect(env.autoFallbackMs).toBeLessThan(AUTO_POLICY.serverDeadlineMs);
    expect(env.baseten.baseUrl).toBe(ENV_DEFAULTS.BASETEN_BASE_URL);
    expect(env.meta.baseUrl).toBe(ENV_DEFAULTS.META_BASE_URL);
    expect(env.routePolicy).toBe("auto");
  });

  it("lets RATE_LIMIT_PER_HOUR 0 turn the hourly limit off but keeps the daily cap at 1 or more", () => {
    expect(readServerEnv({ RATE_LIMIT_PER_HOUR: "0" }).ratePerHour).toBe(0);
    expect(readServerEnv({ DAILY_PRESS_CAP: "1" }).dailyCap).toBe(1);
    expect(readServerEnv({ DAILY_PRESS_CAP: "0" }).dailyCap).toBe(500);
  });

  it("turns live calls off only for 0 or false", () => {
    for (const value of ["0", "false", "FALSE", " False "]) expect(readServerEnv({ LIVE_ENABLED: value }).liveEnabled).toBe(false);
    for (const value of ["1", "true", "yes", "on"]) expect(readServerEnv({ LIVE_ENABLED: value }).liveEnabled).toBe(true);
  });

  it("allows mock only for ALLOW_MOCK 1 outside production", () => {
    expect(readServerEnv({ ALLOW_MOCK: "1", NODE_ENV: "development" }).allowMock).toBe(true);
    expect(readServerEnv({ ALLOW_MOCK: "1" }).allowMock).toBe(true);
    expect(readServerEnv({ ALLOW_MOCK: "1", NODE_ENV: "production" }).allowMock).toBe(false);
    expect(readServerEnv({ ALLOW_MOCK: "true" }).allowMock).toBe(false);
    expect(readServerEnv({ ALLOW_MOCK: "0" }).allowMock).toBe(false);
  });

  it("keeps the dev slug fallback in dev and drops it in production", () => {
    const dev = readServerEnv({ BASETEN_MODEL_FALLBACK: "meta-models/muse-spark-open" });
    expect(dev.baseten.modelFallback).toBe("meta-models/muse-spark-open");
    const prod = readServerEnv({ BASETEN_MODEL_FALLBACK: "meta-models/muse-spark-open", NODE_ENV: "production" });
    expect(prod.baseten.modelFallback).toBeNull();
    expect(prod.baseten.model).toBe("meta-models/muse-spark-open-1026");
    const same = readServerEnv({ BASETEN_MODEL_FALLBACK: ENV_DEFAULTS.BASETEN_MODEL });
    expect(same.baseten.modelFallback).toBeNull();
  });

  it("never accepts a contributor model id", () => {
    const env = readServerEnv({
      META_CARD_MODEL: "muse-spark-1.3-contributor",
      META_ASR_MODEL: "muse-voice-transcribe-1.0-CONTRIBUTOR",
      BASETEN_MODEL: "meta-models/muse-spark-open-contributor",
      BASETEN_MODEL_FALLBACK: "meta-models/muse-spark-open-contributor",
    });
    expect(env.meta.cardModel).toBe(ENV_DEFAULTS.META_CARD_MODEL);
    expect(env.meta.asrModel).toBe(ENV_DEFAULTS.META_ASR_MODEL);
    expect(env.baseten.model).toBe(ENV_DEFAULTS.BASETEN_MODEL);
    expect(env.baseten.modelFallback).toBeNull();
    expect(readServerEnv({ META_CARD_MODEL: "muse-spark-1.2" }).meta.cardModel).toBe("muse-spark-1.2");
  });

  it("reads process.env by default", () => {
    expect(readServerEnv().baseten.baseUrl).toMatch(/^https?:\/\//);
  });
});
