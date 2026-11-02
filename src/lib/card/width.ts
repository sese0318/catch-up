// Width-aware clipping (ux-spec 2-1). Card lane.
import { widthOf } from "./schema";

export { widthOf };

/**
 * Returns text unchanged when widthOf(text) <= cap. Otherwise cuts at the last word or phrase
 * boundary that fits (Intl.Segmenter, granularity "word", locale from lang) and appends "…",
 * so the result including "…" stays within cap. Falls back to a grapheme cut when the first
 * segment alone is wider than cap. Trims trailing spaces and punctuation before the "…".
 */
export function clipToWidth(text: string, cap: number, lang?: string): string {
  void text;
  void cap;
  void lang;
  throw new Error("not implemented");
}
