import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../card/parse", async () => (await import("../server/test-support")).cardParseFake);
vi.mock("../card/prompt", async () => (await import("../server/test-support")).cardPromptFake);

import {
  BASETEN_TEST_KEY,
  chatStream,
  fakeFetch,
  hangingStream,
  headersOf,
  jsonBodyOf,
  makeWav,
  sampleCard,
  statusReply,
  testEnv,
  testMeta,
} from "../server/test-support";
import { readServerEnv } from "../server/env";
import { createOpenWeightsProvider, forgetMissedSlugs } from "./open-weights";
import { toBase64 } from "./shared";
import { BASETEN_BODY_FIELDS, ProviderError, isProviderError, type ProviderRunInput } from "./types";

const URL_B = "https://inference.baseten.co/v1/chat/completions";

function input(patch: Partial<ProviderRunInput> = {}): ProviderRunInput {
  return {
    wav: makeWav(2),
    transcript: null,
    meta: testMeta(),
    signal: new AbortController().signal,
    onStage: () => undefined,
    ...patch,
  };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a ProviderError");
    },
    (e: unknown) => e,
  );
  if (!isProviderError(error)) throw error;
  return error;
}

beforeEach(() => forgetMissedSlugs());

describe("Route B, open_weights on Baseten", () => {
  it("sends the exact body, role, part order, headers and URL", async () => {
    const wav = makeWav(2);
    const { fetchImpl, calls } = fakeFetch(chatStream());
    const provider = createOpenWeightsProvider(testEnv(), { fetchImpl });
    const result = await provider.run(input({ wav }));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_B);
    expect(calls[0].init.method).toBe("POST");
    expect(headersOf(calls[0])).toEqual({
      authorization: `Bearer ${BASETEN_TEST_KEY}`,
      "content-type": "application/json",
      "x-session-affinity": "sess_0123456789abcdef",
    });
    const body = jsonBodyOf(calls[0]);
    expect(body).toEqual({
      model: "meta-models/muse-spark-open-1026",
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        {
          role: "user",
          content: [
            { type: "text", text: "card ja\nmeeting en" },
            { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${toBase64(wav)}` } },
          ],
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "low",
      max_tokens: 2048,
      temperature: 1,
    });
    for (const key of Object.keys(body)) expect(BASETEN_BODY_FIELDS).toContain(key);

    expect(result.body).toEqual(sampleCard);
    expect(result.model).toBe("meta-models/muse-spark-open-1026");
    expect(result.parse).toBe("clean");
  });

  it("sends top_k when set, and leaves temperature out when null", async () => {
    const { fetchImpl, calls } = fakeFetch(chatStream());
    const provider = createOpenWeightsProvider(testEnv({ baseten: { topK: -1, temperature: null, maxTokens: 4096 } }), { fetchImpl });
    await provider.run(input());
    const body = jsonBodyOf(calls[0]);
    expect(body.top_k).toBe(-1);
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty("temperature");
  });

  it("fires the writing stage once at the first answer token and reports usage", async () => {
    const onStage = vi.fn();
    const { fetchImpl } = fakeFetch(
      chatStream({
        reasoning: ["hmm"],
        content: [JSON.stringify(sampleCard).slice(0, 20), JSON.stringify(sampleCard).slice(20)],
        usage: { prompt_tokens: 1100, completion_tokens: 500, prompt_tokens_details: { audio_tokens: 375 } },
      }),
    );
    const result = await createOpenWeightsProvider(testEnv(), { fetchImpl }).run(input({ onStage }));
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onStage.mock.calls[0][0]).toMatchObject({ name: "writing" });
    expect(result.usage).toEqual({ inputTokens: 1100, outputTokens: 500, audioTokens: 375 });
    expect(result.timings.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("retries once with an input_audio part on 400", async () => {
    const wav = makeWav(2);
    const { fetchImpl, calls } = fakeFetch(statusReply(400), chatStream());
    const result = await createOpenWeightsProvider(testEnv(), { fetchImpl }).run(input({ wav }));
    expect(calls).toHaveLength(2);
    const first = jsonBodyOf(calls[0]).messages as { content: unknown }[];
    const second = jsonBodyOf(calls[1]).messages as { content: unknown }[];
    expect((first[1].content as { type: string }[])[1].type).toBe("audio_url");
    expect(second[1].content).toEqual([
      { type: "text", text: "card ja\nmeeting en" },
      { type: "input_audio", input_audio: { data: toBase64(wav), format: "wav" } },
    ]);
    expect(result.body).toEqual(sampleCard);
  });

  it("gives up after the input_audio retry also gets 400", async () => {
    const { fetchImpl, calls } = fakeFetch(statusReply(400), statusReply(400));
    const error = await failure(createOpenWeightsProvider(testEnv(), { fetchImpl }).run(input()));
    expect(calls).toHaveLength(2);
    expect(error.code).toBe("http");
    expect(error.status).toBe(400);
  });

  it("in dev, tries the fallback slug once on 404 and remembers the miss", async () => {
    const env = testEnv({ baseten: { modelFallback: "meta-models/muse-spark-open" } });
    const first = fakeFetch(statusReply(404), chatStream());
    const result = await createOpenWeightsProvider(env, { fetchImpl: first.fetchImpl }).run(input());
    expect(first.calls.map((c) => jsonBodyOf(c).model)).toEqual(["meta-models/muse-spark-open-1026", "meta-models/muse-spark-open"]);
    expect(result.model).toBe("meta-models/muse-spark-open");

    // A new provider instance in the same server instance skips the failing slug.
    const later = fakeFetch(chatStream());
    const again = await createOpenWeightsProvider(env, { fetchImpl: later.fetchImpl }).run(input());
    expect(later.calls.map((c) => jsonBodyOf(c).model)).toEqual(["meta-models/muse-spark-open"]);
    expect(again.model).toBe("meta-models/muse-spark-open");
  });

  it("treats 403 like 404 for the dev slug fallback", async () => {
    const env = testEnv({ baseten: { modelFallback: "meta-models/muse-spark-open" } });
    const { fetchImpl, calls } = fakeFetch(statusReply(403), chatStream());
    const result = await createOpenWeightsProvider(env, { fetchImpl }).run(input());
    expect(calls).toHaveLength(2);
    expect(result.model).toBe("meta-models/muse-spark-open");
  });

  it("never leaves BASETEN_MODEL in production, even with a fallback slug set", async () => {
    const env = readServerEnv({
      NODE_ENV: "production",
      BASETEN_API_KEY: BASETEN_TEST_KEY,
      BASETEN_MODEL_FALLBACK: "meta-models/muse-spark-open",
    });
    const { fetchImpl, calls } = fakeFetch(statusReply(404), statusReply(404));
    const error = await failure(createOpenWeightsProvider(env, { fetchImpl }).run(input()));
    expect(calls).toHaveLength(1);
    expect(jsonBodyOf(calls[0]).model).toBe("meta-models/muse-spark-open-1026");
    expect(error).toMatchObject({ code: "http", status: 404, model: "meta-models/muse-spark-open-1026" });
  });

  it("maps 429 and 529 to rate_limited with Retry-After", async () => {
    for (const status of [429, 529]) {
      const { fetchImpl } = fakeFetch(statusReply(status, { "Retry-After": "7" }));
      const error = await failure(createOpenWeightsProvider(testEnv(), { fetchImpl }).run(input()));
      expect(error).toMatchObject({ code: "rate_limited", status, retryAfterSec: 7 });
    }
  });

  it("accepts only finish_reason stop with an empty refusal and [DONE]", async () => {
    const cases = [
      { spec: { finish: "length" }, code: "length" },
      { spec: { refusal: "I can't help with that." }, code: "refused" },
      { spec: { done: false }, code: "http" },
      { spec: { finish: null, done: false }, code: "http" },
      { spec: { content: [] as string[] }, code: "empty" },
    ];
    for (const { spec, code } of cases) {
      const { fetchImpl } = fakeFetch(chatStream(spec));
      const error = await failure(createOpenWeightsProvider(testEnv(), { fetchImpl }).run(input()));
      expect(error.code, JSON.stringify(spec)).toBe(code);
    }
  });

  it("keeps model text for an Unformatted card when the JSON does not parse, and never in the message", async () => {
    const { fetchImpl } = fakeFetch(chatStream({ content: ["Sorry, here is a summary without JSON."] }));
    const error = await failure(createOpenWeightsProvider(testEnv(), { fetchImpl }).run(input()));
    expect(error.code).toBe("bad_json");
    expect(error.raw).toBe("Sorry, here is a summary without JSON.");
    expect(error.model).toBe("meta-models/muse-spark-open-1026");
    expect(error.message).not.toContain("Sorry");
  });

  it("rejects with aborted when its signal fires", async () => {
    const ctl = new AbortController();
    const { fetchImpl } = fakeFetch(({ init }) => hangingStream(init.signal));
    const pending = createOpenWeightsProvider(testEnv(), { fetchImpl }).run(input({ signal: ctl.signal }));
    setTimeout(() => ctl.abort(), 5);
    expect((await failure(pending)).code).toBe("aborted");
  });

  it("maps a network failure to http", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await failure(createOpenWeightsProvider(testEnv(), { fetchImpl }).run(input()))).code).toBe("http");
  });

  it("refuses without a key, without audio, or with a contributor id, and never calls fetch", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const keyless = createOpenWeightsProvider(testEnv({ baseten: { apiKey: null } }), { fetchImpl });
    expect(keyless.isConfigured()).toBe(false);
    expect((await failure(keyless.run(input()))).code).toBe("not_configured");
    const contributor = createOpenWeightsProvider(testEnv({ baseten: { model: "meta-models/muse-spark-open-contributor" } }), { fetchImpl });
    expect(contributor.isConfigured()).toBe(false);
    expect((await failure(contributor.run(input()))).code).toBe("not_configured");
    const configured = createOpenWeightsProvider(testEnv(), { fetchImpl });
    expect((await failure(configured.run(input({ wav: null, transcript: "hello" })))).code).toBe("bad_input");
    expect(calls).toHaveLength(0);
    expect(configured.modelLabel()).toBe("meta-models/muse-spark-open-1026");
  });
});
