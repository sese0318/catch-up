// Reads an upstream OpenAI-compatible Chat Completions response (Baseten and Meta Model API).
// Server only. Only delta.content is kept, reasoning fields are dropped unread, and the answer stays
// in memory for this request. Nothing here logs.
import type { TokenUsage } from "../protocol";
import { isRecord, usageFromChat } from "./shared";
import { ProviderError, type ProviderId } from "./types";

/** A card is a few hundred tokens. Anything this long is runaway output, treated like length. */
export const MAX_ANSWER_CHARS = 100_000;

export interface ChatOutcome {
  content: string;
  refusal: string;
  finishReason: string | null;
  sawDone: boolean; // data: [DONE] arrived, or a complete non-streaming JSON body
  streamError: boolean; // an error object arrived inside the stream
  overflow: boolean; // content passed MAX_ANSWER_CHARS
  usage?: TokenUsage;
}

export interface ReadChatOptions {
  provider: ProviderId;
  signal: AbortSignal;
  /** Called once, at the first non-empty delta.content. */
  onFirstContent?: () => void;
}

export async function readChatCompletion(res: Response, options: ReadChatOptions): Promise<ChatOutcome> {
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  return type.includes("application/json") ? readJsonBody(res, options) : readEventStream(res, options);
}

function emptyOutcome(): ChatOutcome {
  return { content: "", refusal: "", finishReason: null, sawDone: false, streamError: false, overflow: false };
}

/** Folds one chunk (or a whole non-streaming body) into the outcome. Returns false to stop reading. */
function applyChunk(out: ChatOutcome, chunk: unknown, onContent: () => void): boolean {
  if (!isRecord(chunk)) return true;
  if (chunk.error !== undefined && chunk.error !== null) {
    out.streamError = true;
    return false;
  }
  const usage = usageFromChat(chunk.usage);
  if (usage) out.usage = usage;
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice) || (choice.index !== undefined && choice.index !== 0)) continue;
    const part = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : null;
    if (part) {
      if (typeof part.content === "string" && part.content.length > 0) {
        out.content += part.content;
        onContent();
        if (out.content.length > MAX_ANSWER_CHARS) {
          out.overflow = true;
          return false;
        }
      }
      if (typeof part.refusal === "string") out.refusal += part.refusal;
    }
    if (typeof choice.finish_reason === "string") out.finishReason = choice.finish_reason;
  }
  return true;
}

function firstContentOnce(callback?: () => void): () => void {
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    callback?.();
  };
}

async function readJsonBody(res: Response, { provider, signal, onFirstContent }: ReadChatOptions): Promise<ChatOutcome> {
  const out = emptyOutcome();
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch (error) {
    throw new ProviderError(signal.aborted ? "aborted" : "http", provider, { status: res.status, cause: error });
  }
  if (signal.aborted) throw new ProviderError("aborted", provider);
  applyChunk(out, json, firstContentOnce(onFirstContent));
  out.sawDone = !out.streamError;
  return out;
}

async function readEventStream(res: Response, { provider, signal, onFirstContent }: ReadChatOptions): Promise<ChatOutcome> {
  const out = emptyOutcome();
  if (!res.body) return out;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const onContent = firstContentOnce(onFirstContent);
  const stop = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", stop, { once: true });

  // One JSON chunk per data line, which is how OpenAI-compatible servers frame Chat Completions.
  const line = (text: string): boolean => {
    if (!text.startsWith("data:")) return true; // blank lines, event:, id: and comments
    const payload = text.slice(5).trim();
    if (!payload) return true;
    if (payload === "[DONE]") {
      out.sawDone = true;
      return false;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return true; // a malformed chunk is skipped, the finish checks catch a broken answer
    }
    return applyChunk(out, chunk, onContent);
  };

  let buffer = "";
  let reading = true;
  let ended = false;
  try {
    while (reading) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (let nl = buffer.indexOf("\n"); reading && nl >= 0; nl = buffer.indexOf("\n")) {
        const text = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        reading = line(text);
      }
    }
    if (reading) {
      buffer += decoder.decode();
      if (buffer) line(buffer.replace(/\r$/, ""));
    }
  } catch (error) {
    throw new ProviderError(signal.aborted ? "aborted" : "http", provider, {
      status: res.status,
      raw: out.content || undefined,
      cause: error,
    });
  } finally {
    signal.removeEventListener("abort", stop);
    if (!ended) stop();
  }
  if (signal.aborted) throw new ProviderError("aborted", provider);
  return out;
}

/**
 * Why an answer cannot be used, or null when it can. A card needs finish_reason stop, an empty
 * refusal and some content. requireDone also needs data: [DONE] (Route B, where Baseten can end a
 * stream early without an error event).
 */
export function answerFailure(
  out: ChatOutcome,
  requireDone: boolean,
): "http" | "refused" | "length" | "empty" | null {
  if (out.streamError) return "http";
  if (out.refusal.trim() || out.finishReason === "content_filter") return "refused";
  if (out.overflow || out.finishReason === "length") return "length";
  const complete = out.finishReason === "stop" && (out.sawDone || !requireDone);
  if (!complete) return out.content.trim() ? "http" : "empty";
  return out.content.trim() ? null : "empty";
}
