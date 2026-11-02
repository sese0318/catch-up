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
 * The receipt line (ux-spec 5 item 5), English. For example "Sent 30 s of audio, your name and
 * card language to Muse Spark Open on Baseten at 10:42:40. Nothing saved." Names the backup route
 * when meta.fallbackFrom is set, and the run date for cached cards.
 */
export function receiptText(card: Card, options?: { namesSent?: boolean; timeZone?: string }): string {
  void card;
  void options;
  throw new Error("not implemented");
}
