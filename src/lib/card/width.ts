// Width-aware clipping (ux-spec 2-1). Card lane.
import { widthOf } from "./schema";

export { widthOf };

const ELLIPSIS = "…";
const ELLIPSIS_WIDTH = widthOf(ELLIPSIS);

// Spaces and punctuation that should not sit right before the "…". Closing brackets, closing
// quotes and signs such as % stay, because they belong to the word in front of them.
const TRAILING_JUNK = /[\s\p{Pd}\p{Ps}\p{Pi}\p{Pc},.:;!?、。，．！？；：…‥・·]+$/u;

type Granularity = "word" | "grapheme" | "sentence";
const segmenters = new Map<string, Intl.Segmenter>();

/** A cached Intl.Segmenter. An unknown locale falls back to the default one. */
export function segmenterFor(lang: string | undefined, granularity: Granularity): Intl.Segmenter {
  const key = `${lang ?? ""}|${granularity}`;
  let segmenter = segmenters.get(key);
  if (!segmenter) {
    try {
      segmenter = new Intl.Segmenter(lang, { granularity });
    } catch {
      segmenter = new Intl.Segmenter(undefined, { granularity });
    }
    segmenters.set(key, segmenter);
  }
  return segmenter;
}

function takeWithin(text: string, budget: number, lang: string | undefined, granularity: Granularity): string {
  let out = "";
  let width = 0;
  for (const { segment } of segmenterFor(lang, granularity).segment(text)) {
    const w = widthOf(segment);
    if (width + w > budget) break;
    out += segment;
    width += w;
  }
  return out.replace(TRAILING_JUNK, "");
}

/**
 * Returns text unchanged when widthOf(text) <= cap. Otherwise cuts at the last word or phrase
 * boundary that fits (Intl.Segmenter, granularity "word", locale from lang) and appends "…",
 * so the result including "…" stays within cap. Falls back to a grapheme cut when the first
 * segment alone is wider than cap. Trims trailing spaces and punctuation before the "…".
 */
export function clipToWidth(text: string, cap: number, lang?: string): string {
  if (widthOf(text) <= cap) return text;
  const budget = Math.floor(cap) - ELLIPSIS_WIDTH;
  if (budget < 0) return "";
  const head = takeWithin(text, budget, lang, "word") || takeWithin(text, budget, lang, "grapheme");
  return head + ELLIPSIS;
}

// A sentence break right after one of these is most likely an abbreviation, so the next piece
// stays in the same sentence (ICU breaks "Dr. Smith" and "3 p.m. on Friday" otherwise).
const ABBREVIATION_END =
  /(?:^|[\s(])(?:Dr|Mr|Mrs|Ms|Mx|Prof|Sr|Jr|St|Mt|No|vs|etc|approx|dept|Inc|Ltd|Co|Corp|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun|[A-Z]|(?:[A-Za-z]\.)+[A-Za-z])\.$/;

/**
 * Splits text after its first sentence (Intl.Segmenter, granularity "sentence"), keeping the
 * original spacing of the rest. Returns [text, ""] when there is only one sentence.
 */
export function splitFirstSentence(text: string, lang?: string): [string, string] {
  let end = 0;
  for (const { segment, index } of segmenterFor(lang, "sentence").segment(text)) {
    end = index + segment.length;
    const head = text.slice(0, end).trim();
    if (head && !ABBREVIATION_END.test(head)) break;
  }
  return [text.slice(0, end).trim(), text.slice(end).trim()];
}
