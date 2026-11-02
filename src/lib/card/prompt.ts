// The card prompt (ux-spec 2-2 and 2-3). Card lane. Shared by Route B and Route A.
import type { PressMeta } from "../protocol";
import type { CardLang, Source, WindowSec } from "./schema";

/** Bump whenever systemPrompt() changes. The eval records it next to each result. */
export const PROMPT_VERSION = "card-v1";

/** What the model receives with each press, and nothing else (ux-spec 2-2). */
export interface PromptInput {
  cardLang: CardLang;
  meetingLang: CardLang;
  names: readonly string[];
  hint: string; // empty when there is none
  nowIso: string; // local ISO time with offset
  weekday: string; // English weekday of nowIso
  tz: string | null;
  windowSec: WindowSec;
  source: Source;
  transcript: string | null; // Route A only
}

/**
 * The single system prompt with rules 1 to 11 of ux-spec 2-3. Identical for every press so the
 * provider caches it. JSON only, keys in CARD_KEY_ORDER, caps in width units. It must never
 * contain the words "reasoning effort" or "reasoning strength".
 */
export function systemPrompt(): string {
  throw new Error("not implemented");
}

/**
 * The per-press text part. cardLang, meetingLang, names, hint, now, windowSec and source, plus
 * the transcript on Route A. Route B sends it before the audio part.
 */
export function userText(input: PromptInput): string {
  void input;
  throw new Error("not implemented");
}

/** PromptInput from the decoded X-CatchUp-Meta header. weekday comes from weekdayOfIso. */
export function promptInputFromMeta(meta: PressMeta, transcript?: string | null): PromptInput {
  void meta;
  void transcript;
  throw new Error("not implemented");
}
