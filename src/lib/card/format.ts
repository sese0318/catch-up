// Plain text, Markdown, receipt and language-of-parts helpers. Card lane. Pure functions.
import type { ErrorCode } from "../codes";
import { LIVE_ROUTE_LABELS, routeLabelOf, type Card, type CardLang, type CardMeta, type SayLang } from "./schema";
import { localString, type LocalStringKey } from "./strings";

export type ScriptLang = "en" | "ja" | "zh-Hans";

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;

/** Script check for lang attributes (ux-spec 6 item 4). Kana means ja, Han only means zh-Hans, else en. */
export function scriptLangOf(text: string): ScriptLang {
  if (KANA.test(text)) return "ja";
  if (HAN.test(text)) return "zh-Hans";
  return "en";
}

/** BCP 47 tag for a card or say language. zh is always zh-Hans, other is und. */
export function langTag(lang: CardLang | SayLang): string {
  switch (lang) {
    case "en":
      return "en";
    case "ja":
      return "ja";
    case "zh":
      return "zh-Hans";
    default:
      return "und";
  }
}

// Plain text in the card language

type Script = "en" | "ja" | "zh";

function scriptOf(text: string): Script {
  const lang = scriptLangOf(text);
  return lang === "zh-Hans" ? "zh" : lang;
}

/** " (a, b)" in English, "（a、b）" in Japanese, "（a，b）" in Chinese, "" when empty. */
function paren(lang: Script, parts: readonly string[]): string {
  if (parts.length === 0) return "";
  if (lang === "ja") return `（${parts.join("、")}）`;
  if (lang === "zh") return `（${parts.join("，")}）`;
  return ` (${parts.join(", ")})`;
}

function quoted(text: string, lang: Script): string {
  if (lang === "ja") return `「${text}」`;
  if (lang === "zh") return `“${text}”`;
  return `"${text}"`;
}

const ASK_LABELS: Readonly<Record<Card["ask"]["to"], LocalStringKey>> = {
  you: "askedYou",
  room: "room",
  mentioned: "mentioned",
  none: "none",
};

const HEARD_NOTES: Readonly<Record<Card["heard"], LocalStringKey | null>> = {
  clear: null,
  partial: "partial",
  poor: "poor",
  none: "noSpeech",
};

interface CardParts {
  ask: string[]; // label, then the text with the asker
  say: string[]; // label with the AI tag, the line, then the gloss
  summary: string[]; // hearing note, then the summary lines
  facts: string[];
  quote: string[]; // label, then the quote
}

function cardParts(card: Card): CardParts {
  const lang = card.meta.cardLang;
  const s = (key: LocalStringKey) => localString(lang, key);
  const heardNote = HEARD_NOTES[card.heard];
  const parts: CardParts = { ask: [], say: [], summary: [], facts: [], quote: [] };
  if (card.heard !== "none") {
    parts.ask.push(s(ASK_LABELS[card.ask.to]));
    if (card.ask.text) parts.ask.push(`${card.ask.text}${paren(lang, card.ask.by ? [card.ask.by] : [])}`);
  }
  if (card.say) {
    parts.say.push(`${s(card.ask.to === "none" ? "sayNone" : "sayAsked")}${paren(lang, [s("aiTag")])}`, card.say.text);
    if (card.say.gloss) parts.say.push(`${s("glossLabel")}${lang === "en" ? " " : ""}${quoted(card.say.gloss, lang)}`);
  }
  if (heardNote) parts.summary.push(s(heardNote));
  parts.summary.push(...card.summary);
  for (const fact of card.facts) {
    const extra = [...(fact.unsure ? [s("unsure")] : []), ...(fact.note ? [fact.note] : [])];
    parts.facts.push(`${fact.text}${paren(lang, extra)}`);
  }
  if (card.quote) parts.quote.push(s("evidence"), quoted(card.quote, scriptOf(card.quote)));
  return parts;
}

/** Copy card. Plain text in panic order, ask then say then summary, facts and quote. */
export function cardToPlainText(card: Card): string {
  if (card.meta.unformatted) return card.summary[0];
  const parts = cardParts(card);
  return [parts.ask, parts.say, parts.summary, parts.facts.map((f) => `• ${f}`), parts.quote]
    .filter((block) => block.length > 0)
    .map((block) => block.join("\n"))
    .join("\n\n");
}

// Markdown export

const MD_SPECIAL = /[\\`*_~[\]<>|]/g;

/** Escapes Markdown syntax and HTML in one line of card text. */
function md(text: string): string {
  return text
    .replace(MD_SPECIAL, "\\$&")
    .replace(/^[#+=-]/, "\\$&") // heading, list or rule at the start of a line
    .replace(/^(\d+)([.)])/, "$1\\$2"); // ordered list marker
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function exportStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function cardMarkdown(card: Card): string[] {
  const clock = wallClock(card.meta.pressedAt);
  const out = [`## Catch-up${clock ? ` at ${clock.slice(0, 5)}` : ""}`, ""];
  if (card.meta.unformatted) {
    out.push("**Unformatted**", "", ...card.summary[0].split("\n").map((line) => `> ${md(line)}`), "");
  } else {
    const parts = cardParts(card);
    const labeled = (block: string[]) => {
      if (block.length === 0) return;
      out.push(`**${md(block[0])}**`, "");
      for (const line of block.slice(1)) out.push(md(line), "");
    };
    labeled(parts.ask);
    labeled(parts.say);
    for (const line of parts.summary) out.push(md(line), "");
    if (parts.facts.length > 0) out.push(...parts.facts.map((f) => `* ${md(f)}`), "");
    if (parts.quote.length > 0) out.push(`**${md(parts.quote[0])}**`, "", `> ${md(parts.quote[1])}`, "");
  }
  out.push(`_${md(receiptText(card))}_`);
  return out;
}

/** Export .md for the session, oldest card first, with each card's receipt. */
export function cardsToMarkdown(cards: readonly Card[], options: { exportedAt?: Date } = {}): string {
  const ordered = cards
    .map((card, i) => ({ card, i, t: Date.parse(card.meta.pressedAt) }))
    .sort((a, b) => (Number.isNaN(a.t) || Number.isNaN(b.t) ? 0 : a.t - b.t) || a.i - b.i)
    .map((entry) => entry.card);
  const intro = [
    ...(options.exportedAt ? [`Exported ${exportStamp(options.exportedAt)}.`] : []),
    `${ordered.length} ${ordered.length === 1 ? "card" : "cards"}.`,
    "Cards are written by AI and can be wrong.",
  ];
  const out = ["# Catch Up session", "", intro.join(" ")];
  for (const card of ordered) out.push("", ...cardMarkdown(card));
  return `${out.join("\n")}\n`;
}

// Receipt

/** HH:MM:SS written in a local ISO string, the presser's own clock. */
function wallClock(iso: string): string | null {
  const m = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  return m ? `${m[1]}:${m[2]}:${m[3] ?? "00"}` : null;
}

function clockTime(iso: string, timeZone?: string): string | null {
  if (timeZone) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) {
      try {
        return new Intl.DateTimeFormat("en-GB", {
          timeZone,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        }).format(ms);
      } catch {
        // an unknown zone falls back to the wall clock in the string
      }
    }
  }
  return wallClock(iso);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Nov 3, 2026" from a date or ISO time, read as written (no time zone shift). */
function runDate(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return value.trim() || null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : value.trim();
}

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What left the device with this press, from meta.sent. */
function sentItems(meta: CardMeta): string {
  const window = `${meta.windowSec} s`;
  const items: string[] = [];
  if (meta.sent.body === "audio") {
    items.push(
      meta.sentSec < meta.windowSec - 0.5
        ? `the last ${Math.max(1, Math.round(meta.sentSec))} s of audio (all there was for the ${window} window)`
        : `the last ${window} of audio`,
    );
  } else if (meta.sent.body === "transcript") {
    items.push(`the earlier transcript of the last ${window}`);
  }
  // A sample press sends the clip's listener names, never the visitor's own.
  if (meta.sent.names) items.push(meta.source === "sample" ? "the sample's listener name" : "your name");
  if (meta.sent.hint) items.push("your hint");
  items.push("card language");
  return joinAnd(items);
}

const PAUSED = "Live cards are paused for now.";

/** Why a saved card stood in for this press, from meta.cachedBecause. */
const CACHED_REASONS: Readonly<Record<ErrorCode, string>> = {
  bad_request: "The live card didn't come through.",
  bad_audio: "The live card didn't come through.",
  too_large: "The live card didn't come through.",
  rate_limited: PAUSED,
  daily_cap: PAUSED,
  live_off: PAUSED,
  not_configured: "Live cards aren't set up on this server.",
  mock_refused: "The live card didn't come through.",
  timeout: "The live card took too long.",
  provider_error: "The model service returned an error.",
  server_error: "Catch Up's server had a problem.",
  offline: "You're offline.",
  network: "Catch Up's server couldn't be reached.",
  aborted: "The live card didn't come through.",
};

const SAVED_NOTHING = "Catch Up saved nothing.";

/**
 * The receipt (ux-spec 5 item 5, must have 5), English app chrome that passes copyRuleProblems.
 * It always holds the window, the route label from routeLabelOf(meta) (plus the label of
 * meta.fallbackFrom when the backup route was used), meta.model, ms.total in seconds with one
 * decimal, the clock time of pressedAt, and ends with "Catch Up saved nothing." What left the
 * device comes from meta.sent (audio or the earlier transcript, your name when names, or the
 * sample's listener name on a sample, your hint when hint). For example "Sent the last 30 s of audio, your name and card language to Muse Spark
 * Open on Baseten (meta-models/muse-spark-open-1026) at 10:42:40. Card in 2.9 s. Catch Up saved
 * nothing." A cached card says why from meta.cachedBecause and names its saved run (label, model,
 * meta.cachedRunAt and its seconds) without claiming a model got this press. A mock card says
 * "Sample card, no model was called. Catch Up saved nothing."
 */
export function receiptText(card: Card, options: { timeZone?: string } = {}): string {
  const meta = card.meta;
  if (meta.route === "mock") return `${routeLabelOf(meta)}. ${SAVED_NOTHING}`;
  const clock = clockTime(meta.pressedAt, options.timeZone);
  const at = clock ? ` at ${clock}` : "";
  if (meta.route === "cached") {
    const reason = meta.cachedBecause ? CACHED_REASONS[meta.cachedBecause] : "This card comes from a saved run.";
    const run = runDate(meta.cachedRunAt);
    const saved = `${routeLabelOf(meta)} (${meta.model})${run ? `, run ${run}` : ""}, card in ${seconds(meta.ms.total)}.`;
    const left =
      meta.sent.body === "none"
        ? `Nothing left your device${at}.`
        : `This press${at} sent ${sentItems(meta)}, and no live card came back.`;
    return `${reason} ${saved} ${left} ${SAVED_NOTHING}`;
  }
  const served = `${routeLabelOf(meta)} (${meta.model})`;
  const to = meta.fallbackFrom
    ? `${LIVE_ROUTE_LABELS[meta.fallbackFrom]} and then, by the backup route, to ${served}`
    : served;
  return `Sent ${sentItems(meta)} to ${to}${at}. Card in ${seconds(meta.ms.total)}. ${SAVED_NOTHING}`;
}
