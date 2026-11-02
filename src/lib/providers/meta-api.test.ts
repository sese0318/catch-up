import { describe, expect, it, vi } from "vitest";

vi.mock("../card/parse", async () => (await import("../server/test-support")).cardParseFake);
vi.mock("../card/prompt", async () => (await import("../server/test-support")).cardPromptFake);

import { META_RESPONSE_FORMAT } from "../card/schema";
import {
  META_TEST_KEY,
  chatStream,
  fakeFetch,
  headersOf,
  jsonBodyOf,
  makeWav,
  parseMultipart,
  sampleCard,
  statusReply,
  testEnv,
  testMeta,
  type FetchCall,
} from "../server/test-support";
import { buildAsrMultipart, createMetaApiProvider } from "./meta-api";
import { META_CHAT_BODY_FIELDS, isProviderError, type ProviderError, type ProviderRunInput } from "./types";

const ASR_URL = "https://api.meta.ai/v1/asr/transcribe";
const CHAT_URL = "https://api.meta.ai/v1/chat/completions";

function asrReply(transcript = "So Zephyrine, does Thursday work for the demo?", audioDurationMs = 2000): Response {
  return Response.json({ sessionId: "s1", transcript, audioDurationMs, turns: [] });
}

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

function partsOf(call: FetchCall) {
  return parseMultipart(call.init.body as Uint8Array, headersOf(call)["content-type"]);
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

describe("Route A, meta_api on Meta Model API", () => {
  it("transcribes in PUSH_TO_TALK with a multipart request part and the WAV as clip.wav", async () => {
    const wav = makeWav(2);
    const { fetchImpl, calls } = fakeFetch(asrReply(), chatStream());
    await createMetaApiProvider(testEnv(), { fetchImpl }).run(input({ wav }));

    expect(calls[0].url).toBe(ASR_URL);
    expect(calls[0].init.method).toBe("POST");
    const headers = headersOf(calls[0]);
    expect(headers.authorization).toBe(`Bearer ${META_TEST_KEY}`);
    expect(headers.accept).toBe("application/json");
    expect(headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);

    const parts = partsOf(calls[0]);
    expect(parts.map((p) => p.name)).toEqual(["request", "audio"]);
    const [request, audio] = parts;
    expect(request.filename).toBeNull();
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(request.data))).toEqual({
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "PUSH_TO_TALK",
      languageBias: ["English", "Japanese"],
      keywords: ["Zephyrine", "ゼフィ", "Quillfeather", "Project Marmalade"],
    });
    expect(audio.filename).toBe("clip.wav");
    expect(audio.headers["content-type"]).toBe("audio/wav");
    expect([...audio.data]).toEqual([...wav]);
  });

  it("writes the card from the transcript with the exact body and the developer role", async () => {
    const { fetchImpl, calls } = fakeFetch(asrReply(), chatStream());
    const result = await createMetaApiProvider(testEnv(), { fetchImpl }).run(input());

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(CHAT_URL);
    expect(headersOf(calls[1])).toEqual({ authorization: `Bearer ${META_TEST_KEY}`, "content-type": "application/json" });
    const body = jsonBodyOf(calls[1]);
    expect(body).toEqual({
      model: "muse-spark-1.3",
      messages: [
        { role: "developer", content: "SYSTEM PROMPT" },
        { role: "user", content: "card ja\nmeeting en\ntranscript So Zephyrine, does Thursday work for the demo?" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "minimal",
      max_completion_tokens: 4000,
      response_format: META_RESPONSE_FORMAT,
    });
    expect(Object.keys(body).sort()).toEqual([...META_CHAT_BODY_FIELDS].sort());
    expect(JSON.stringify(body)).not.toContain("base64");

    expect(result.body).toEqual(sampleCard);
    expect(result.model).toBe("muse-voice-transcribe-1.0 + muse-spark-1.3");
    expect(result.transcript).toBe("So Zephyrine, does Thursday work for the demo?");
    expect(result.usage).toMatchObject({ audioSeconds: 2 });
    expect(result.timings.asrMs).toBeGreaterThanOrEqual(0);
  });

  it("skips transcription for a transcript body and names only the card model", async () => {
    const { fetchImpl, calls } = fakeFetch(chatStream());
    const result = await createMetaApiProvider(testEnv(), { fetchImpl }).run(
      input({ wav: null, transcript: "Earlier words", meta: testMeta({ route: "meta_api", cardLang: "zh" }) }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CHAT_URL);
    const messages = jsonBodyOf(calls[0]).messages as { content: string }[];
    expect(messages[1].content).toBe("card zh\nmeeting en\ntranscript Earlier words");
    expect(result.model).toBe("muse-spark-1.3");
    expect(result.transcript).toBe("Earlier words");
    expect(result.timings.asrMs).toBeUndefined();
  });

  it("retries the transcription once with a plain request field on 400", async () => {
    const { fetchImpl, calls } = fakeFetch(statusReply(400), asrReply(), chatStream());
    await createMetaApiProvider(testEnv(), { fetchImpl }).run(input());
    expect(calls.map((c) => c.url)).toEqual([ASR_URL, ASR_URL, CHAT_URL]);
    const retried = partsOf(calls[1]);
    expect(retried[0].name).toBe("request");
    expect(retried[0].headers["content-type"]).toBeUndefined();
    expect(retried[0].filename).toBeNull();
    expect(JSON.parse(new TextDecoder().decode(retried[0].data)).mode).toBe("PUSH_TO_TALK");
  });

  it("fails with the transcription status and does not call the card model", async () => {
    const { fetchImpl, calls } = fakeFetch(statusReply(500));
    const error = await failure(createMetaApiProvider(testEnv(), { fetchImpl }).run(input()));
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ code: "http", status: 500 });
  });

  it("keeps the transcript and model text on a card failure, never in the message", async () => {
    const { fetchImpl } = fakeFetch(asrReply("The words"), chatStream({ finish: "length", content: ['{"heard":"cle'] }));
    const error = await failure(createMetaApiProvider(testEnv(), { fetchImpl }).run(input()));
    expect(error.code).toBe("length");
    expect(error.raw).toBe('{"heard":"cle');
    expect(error.transcript).toBe("The words");
    expect(error.model).toBe("muse-voice-transcribe-1.0 + muse-spark-1.3");
    expect(error.message).not.toContain("words");
  });

  it("accepts a clean end without [DONE], since Meta documents only the final finish_reason", async () => {
    const { fetchImpl } = fakeFetch(asrReply(), chatStream({ done: false }));
    const result = await createMetaApiProvider(testEnv(), { fetchImpl }).run(input());
    expect(result.body).toEqual(sampleCard);
  });

  it("never calls a contributor model", async () => {
    const { fetchImpl, calls } = fakeFetch();
    for (const meta of [{ cardModel: "muse-spark-1.3-contributor" }, { asrModel: "muse-voice-transcribe-1.0-contributor" }]) {
      const provider = createMetaApiProvider(testEnv({ meta }), { fetchImpl });
      expect(provider.isConfigured()).toBe(false);
      expect((await failure(provider.run(input()))).code).toBe("not_configured");
    }
    expect(calls).toHaveLength(0);
  });

  it("is not configured without MODEL_API_KEY and labels both models", () => {
    expect(createMetaApiProvider(testEnv({ meta: { apiKey: null } })).isConfigured()).toBe(false);
    expect(createMetaApiProvider(testEnv()).modelLabel()).toBe("muse-voice-transcribe-1.0 + muse-spark-1.3");
  });
});

describe("buildAsrMultipart", () => {
  it("frames UTF-8 keywords and binary audio with CRLF boundaries", () => {
    const wav = makeWav(1);
    const request = { model: "m", audioEncoding: "WAV", mode: "PUSH_TO_TALK", languageBias: ["Japanese"], keywords: ["星佳"] } as const;
    const { body, contentType } = buildAsrMultipart({ ...request, languageBias: [...request.languageBias], keywords: [...request.keywords] }, wav, "json", "B0UNDARY");
    expect(contentType).toBe("multipart/form-data; boundary=B0UNDARY");
    const text = Buffer.from(body).toString("latin1");
    expect(text.startsWith("--B0UNDARY\r\n")).toBe(true);
    expect(text.endsWith("\r\n--B0UNDARY--\r\n")).toBe(true);
    const parts = parseMultipart(body, contentType);
    expect(JSON.parse(new TextDecoder().decode(parts[0].data)).keywords).toEqual(["星佳"]);
    expect(parts[1].data.byteLength).toBe(wav.byteLength);
  });
});
