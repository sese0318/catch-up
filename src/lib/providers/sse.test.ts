import { describe, expect, it, vi } from "vitest";
import { chatStream, hangingStream, sampleCardJson } from "../server/test-support";
import { isProviderError } from "./types";
import { MAX_ANSWER_CHARS, answerFailure, readChatCompletion } from "./sse";

const read = (res: Response, onFirstContent?: () => void, signal = new AbortController().signal) =>
  readChatCompletion(res, { provider: "open_weights", signal, onFirstContent });

function rawStream(text: string, contentType = "text/event-stream"): Response {
  return new Response(text, { headers: { "Content-Type": contentType } });
}

describe("readChatCompletion", () => {
  it("keeps only delta.content, ignores reasoning and fires the first content once", async () => {
    const onFirst = vi.fn();
    const out = await read(
      chatStream({
        reasoning: ["thinking about the clip"],
        content: ['{"heard":', '"clear"}'],
        usage: {
          prompt_tokens: 1100,
          completion_tokens: 600,
          prompt_tokens_details: { cached_tokens: 700, audio_tokens: 375 },
          completion_tokens_details: { reasoning_tokens: 400 },
        },
      }),
      onFirst,
    );
    expect(out.content).toBe('{"heard":"clear"}');
    expect(out.content).not.toContain("thinking");
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ finishReason: "stop", sawDone: true, refusal: "", streamError: false });
    expect(out.usage).toEqual({ inputTokens: 1100, cachedTokens: 700, audioTokens: 375, outputTokens: 600, reasoningTokens: 400 });
    expect(answerFailure(out, true)).toBeNull();
  });

  it("handles CRLF framing, data lines without a space and chunks split mid-line", async () => {
    const chunk = (content: string, finish: string | null = null) =>
      JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
    const text = `: keep-alive\r\ndata:${chunk("ab")}\r\n\r\ndata: ${chunk("c", "stop")}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const out = await read(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    expect(out.content).toBe("abc");
    expect(out.finishReason).toBe("stop");
    expect(out.sawDone).toBe(true);
  });

  it("reads a non-streaming JSON body as a complete answer", async () => {
    const onFirst = vi.fn();
    const body = JSON.stringify({
      choices: [{ index: 0, message: { content: sampleCardJson, reasoning_content: "hidden" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const out = await read(rawStream(body, "application/json"), onFirst);
    expect(out.content).toBe(sampleCardJson);
    expect(out.sawDone).toBe(true);
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(answerFailure(out, true)).toBeNull();
  });

  it("marks an error object inside the stream", async () => {
    const out = await read(rawStream(`data: {"error":{"message":"overloaded"}}\n\n`));
    expect(out.streamError).toBe(true);
    expect(answerFailure(out, true)).toBe("http");
  });

  it("stops at runaway output", async () => {
    const out = await read(chatStream({ content: ["x".repeat(MAX_ANSWER_CHARS + 1)] }));
    expect(out.overflow).toBe(true);
    expect(answerFailure(out, true)).toBe("length");
  });

  it("rejects with aborted when the signal fires mid-stream", async () => {
    const ctl = new AbortController();
    const pending = read(hangingStream(), undefined, ctl.signal);
    ctl.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(isProviderError(error) && error.code).toBe("aborted");
  });
});

describe("answerFailure", () => {
  const base = { content: sampleCardJson, refusal: "", finishReason: "stop", sawDone: true, streamError: false, overflow: false };

  it("accepts only stop with an empty refusal, and [DONE] when required", () => {
    expect(answerFailure(base, true)).toBeNull();
    expect(answerFailure({ ...base, sawDone: false }, true)).toBe("http");
    expect(answerFailure({ ...base, sawDone: false }, false)).toBeNull();
    expect(answerFailure({ ...base, finishReason: null }, false)).toBe("http");
    expect(answerFailure({ ...base, content: "", finishReason: null, sawDone: false }, true)).toBe("empty");
    expect(answerFailure({ ...base, finishReason: "length" }, true)).toBe("length");
    expect(answerFailure({ ...base, refusal: "I can't help with that." }, true)).toBe("refused");
    expect(answerFailure({ ...base, finishReason: "content_filter" }, true)).toBe("refused");
    expect(answerFailure({ ...base, content: "  " }, true)).toBe("empty");
  });
});
