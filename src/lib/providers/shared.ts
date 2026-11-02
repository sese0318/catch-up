// Helpers shared by the live providers. Server only. Nothing here logs or keeps content.
import type { TokenUsage } from "../protocol";
import { ProviderError, type ProviderErrorOptions, type ProviderId } from "./types";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Looks up the global fetch at call time, so tests can stub it. */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export interface ProviderOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** A copy of body with only the listed keys, so a closed upstream schema never sees an extra field. */
export function onlyFields<T extends object>(body: T, fields: readonly string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of fields) {
    if (key in body && (body as Record<string, unknown>)[key] !== undefined) {
      (out as Record<string, unknown>)[key] = (body as Record<string, unknown>)[key];
    }
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Retry-After in whole seconds, from delta seconds or an HTTP date. */
export function retryAfterSeconds(headers: Headers, nowMs: number): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.min(Math.ceil(seconds), 86_400) : undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > nowMs ? Math.min(Math.ceil((at - nowMs) / 1000), 86_400) : undefined;
}

/** Frees the connection of a response that will not be read. Error bodies are never read or logged. */
export async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

/** A failed upstream status. 429 and Baseten's 529 (overloaded) are rate limits that carry Retry-After. */
export async function statusError(
  provider: ProviderId,
  res: Response,
  nowMs: number,
  options: Pick<ProviderErrorOptions, "model" | "transcript"> = {},
): Promise<ProviderError> {
  await discardBody(res);
  const limited = res.status === 429 || res.status === 529;
  return new ProviderError(limited ? "rate_limited" : "http", provider, {
    ...options,
    status: res.status,
    retryAfterSec: limited ? retryAfterSeconds(res.headers, nowMs) : undefined,
  });
}

/** fetch that rejects only with a ProviderError, aborted when the signal fired and http otherwise. */
export async function fetchUpstream(
  fetchImpl: FetchLike,
  provider: ProviderId,
  url: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<Response> {
  if (init.signal.aborted) throw new ProviderError("aborted", provider);
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw new ProviderError(init.signal.aborted ? "aborted" : "http", provider, { cause: error });
  }
}

const nonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** OpenAI-style usage (prompt_tokens, completion_tokens and their details) as TokenUsage. */
export function usageFromChat(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const prompt = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const completion = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : {};
  const usage: TokenUsage = {
    inputTokens: nonNegative(raw.prompt_tokens),
    cachedTokens: nonNegative(prompt.cached_tokens),
    audioTokens: nonNegative(prompt.audio_tokens),
    outputTokens: nonNegative(raw.completion_tokens),
    reasoningTokens: nonNegative(completion.reasoning_tokens),
  };
  return compactUsage(usage);
}

/** Drops undefined fields, and returns undefined when nothing is left. */
export function compactUsage(usage: TokenUsage): TokenUsage | undefined {
  const out: TokenUsage = {};
  for (const [key, value] of Object.entries(usage) as [keyof TokenUsage, number | undefined][]) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
