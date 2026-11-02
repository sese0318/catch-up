// Guarded calls into the card lane (strings, format, width). While another lane is still filling
// in its stub, a call can throw, so the UI falls back to a plain English version instead of
// crashing. Once the card lane lands, these return exactly what the card lane returns.
import { cardToPlainText, cardsToMarkdown, langTag, receiptText, scriptLangOf, type ScriptLang } from "../card/format";
import type { Card, CardLang, SayLang, WindowSec } from "../card/schema";
import { headsUpLine, localString, repeatLine, stallLine, type LocalStringKey } from "../card/strings";
import { clipToWidth } from "../card/width";
import { clockOfIso, formatSeconds } from "./format";

const EN_FALLBACK: Readonly<Record<LocalStringKey, string>> = {
  stall: "Let me think about that for a second.",
  repeat: "Sorry, could you say that last part again?",
  stallLabel: "If they're waiting on you",
  askedYou: "Asked you",
  room: "Question to the room",
  mentioned: "You were mentioned",
  none: "Nothing asked of you",
  sayAsked: "To check, say",
  sayNone: "To jump back in",
  aiTag: "AI-suggested",
  glossLabel: "Means",
  evidence: "What they said",
  unsure: "Check",
  partial: "Some parts were hard to hear",
  poor: "Hard to hear, details may be off",
  noSpeech: "Couldn't make out any speech",
};

function attempt<T>(run: () => T, fallback: () => T): T {
  try {
    return run();
  } catch {
    return fallback();
  }
}

/** A label in the card language, from the ux-spec 2-7 table. */
export function label(lang: CardLang, key: LocalStringKey): string {
  return attempt(
    () => localString(lang, key),
    () => EN_FALLBACK[key],
  );
}

export function stallText(lang: CardLang): string {
  return attempt(
    () => stallLine(lang),
    () => EN_FALLBACK.stall,
  );
}

export function repeatText(lang: CardLang): string {
  return attempt(
    () => repeatLine(lang),
    () => EN_FALLBACK.repeat,
  );
}

export function headsUpText(lang: CardLang, windowSec: WindowSec): string {
  return attempt(
    () => headsUpLine(lang, windowSec),
    () =>
      `Heads up, I use Catch Up, an AI accessibility tool. Only when I tap, it sends the last ${windowSec} seconds of audio to an AI model for a short recap. Catch Up saves nothing. Tell me if you'd rather I turn it off.`,
  );
}

const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const HAN = /[㐀-䶿一-鿿豈-﫿]/;

/** lang attribute for quotes, fact text and transcripts (ux-spec 6 item 4). */
export function scriptLang(text: string): ScriptLang {
  return attempt(
    () => scriptLangOf(text),
    () => (KANA.test(text) ? "ja" : HAN.test(text) ? "zh-Hans" : "en"),
  );
}

/** BCP 47 tag for a card or say language. zh is zh-Hans and other is und. */
export function tagOf(lang: CardLang | SayLang): string {
  return attempt(
    () => langTag(lang),
    () => (lang === "zh" ? "zh-Hans" : lang === "other" ? "und" : lang),
  );
}

/** The receipt line under every card. */
export function receiptOf(card: Card, timeZone?: string): string {
  return attempt(
    () => receiptText(card, timeZone ? { timeZone } : undefined),
    () => {
      const m = card.meta;
      if (m.route === "mock") return "Sample card, no model was called. Catch Up saved nothing.";
      const what = m.sent.body === "transcript" ? "the earlier transcript" : `the last ${Math.round(m.sentSec)} s of audio`;
      return `Sent ${what} to ${m.model} at ${clockOfIso(m.pressedAt)}. Card in ${formatSeconds(m.ms.total)}. Catch Up saved nothing.`;
    },
  );
}

/** Copy card, plain text in panic order. */
export function plainTextOf(card: Card): string {
  return attempt(
    () => cardToPlainText(card),
    () =>
      [card.ask.text, card.say?.text, ...card.summary, ...card.facts.map((f) => (f.note ? `${f.text} (${f.note})` : f.text)), card.quote]
        .filter((part): part is string => Boolean(part))
        .join("\n"),
  );
}

/** Export .md, oldest card first. */
export function markdownOf(cardsOldestFirst: readonly Card[], exportedAt: Date): string {
  return attempt(
    () => cardsToMarkdown(cardsOldestFirst, { exportedAt }),
    () =>
      ["# Catch Up session", "", ...cardsOldestFirst.map((c) => `## ${clockOfIso(c.meta.pressedAt)}\n\n${plainTextOf(c)}\n\n${receiptOf(c)}\n`)].join(
        "\n",
      ),
  );
}

/** Width-aware clip for display, never longer than cap width units. */
export function clip(text: string, cap: number, lang?: string): string {
  return attempt(
    () => clipToWidth(text, cap, lang),
    () => text,
  );
}
