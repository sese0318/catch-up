// Plain text, Markdown, receipt and language-of-parts helpers. Card lane. Pure functions.
import type { Card, CardLang, SayLang } from "./schema";

export type ScriptLang = "en" | "ja" | "zh-Hans";

/** Script check for lang attributes (ux-spec 6 item 4). Kana means ja, Han only means zh-Hans, else en. */
export function scriptLangOf(text: string): ScriptLang {
  void text;
  throw new Error("not implemented");
}

/** BCP 47 tag for a card or say language. zh is always zh-Hans, other is und. */
export function langTag(lang: CardLang | SayLang): string {
  void lang;
  throw new Error("not implemented");
}

/** Copy card. Plain text in panic order, ask then say then summary, facts and quote. */
export function cardToPlainText(card: Card): string {
  void card;
  throw new Error("not implemented");
}

/** Export .md for the session, oldest card first, with each card's receipt. */
export function cardsToMarkdown(cards: readonly Card[], options?: { exportedAt?: Date }): string {
  void cards;
  void options;
  throw new Error("not implemented");
}

/**
 * The receipt (ux-spec 5 item 5, must have 5), English app chrome that passes copyRuleProblems.
 * It always holds the window, the route label from routeLabelOf(meta) (plus the label of
 * meta.fallbackFrom when the backup route was used), meta.model, ms.total in seconds with one
 * decimal, the clock time of pressedAt, and ends with "Catch Up saved nothing." What left the
 * device comes from meta.sent (audio or the earlier transcript, your name when names, your hint
 * when hint). For example "Sent the last 30 s of audio, your name and card language to Muse Spark
 * Open on Baseten (meta-models/muse-spark-open-1026) at 10:42:40. Card in 2.9 s. Catch Up saved
 * nothing." A cached card says why from meta.cachedBecause and names its saved run (label, model,
 * meta.cachedRunAt and its seconds) without claiming a model got this press. A mock card says
 * "Sample card, no model was called. Catch Up saved nothing."
 */
export function receiptText(card: Card, options?: { timeZone?: string }): string {
  void card;
  void options;
  throw new Error("not implemented");
}
