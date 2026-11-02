// Server-side card parsing (ux-spec 2-5). Card lane. Pure, no I/O, never logs model text.
import { scriptLangOf } from "./format";
import {
  ASK_TO_VALUES,
  CAPS,
  CARD_KEY_ORDER,
  CardBody,
  FACT_KINDS,
  HEARD_VALUES,
  MAX_FACTS,
  MAX_SUMMARY,
  SAY_LANGS,
  UNFORMATTED_MAX_CHARS,
  widthOf,
  type Ask,
  type AskTo,
  type CardLang,
  type Fact,
  type FactKind,
  type Heard,
  type Say,
  type SayLang,
  type Summary,
} from "./schema";
import { localString, repeatLine } from "./strings";
import { clipToWidth, splitFirstSentence } from "./width";

/** Built by the server from the decoded PressMeta. */
export interface ClampContext {
  cardLang: CardLang;
  meetingLang: CardLang; // the language of the repeat line filled in when heard is poor
}

export type ParseOutcome =
  | { ok: true; body: CardBody; quality: "clean" | "clamped" }
  | { ok: false; reason: "empty" | "no_json" | "bad_json" | "not_card" };

// Model text cleanup

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
// The final answer starts after the last header addressed to the user, when recipient markup leaks.
const ANSWER_HEADER = /\bto=(?:user|final)\b|<\|channel\|>\s*final\b/gi;
const CONTROL_TOKEN = /<\|[^|<>]{0,64}\|>/g;
const RECIPIENT_HEADER = /^[ \t]*(?:assistant[ \t]+)?to=[\w.:-]+[ \t]*/gim;
const CODE_FENCE = /```[ \t]*(?:jsonc|json5|json|javascript|js|typescript|ts|text)?/gi;

/** Removes <|...|> control tokens, stray to= headers and code fences, then trims. */
export function stripModelText(raw: string): string {
  let text = String(raw ?? "").replace(THINK_BLOCK, " ");
  let answerStart = -1;
  for (const m of text.matchAll(ANSWER_HEADER)) answerStart = (m.index ?? 0) + m[0].length;
  if (answerStart >= 0) text = text.slice(answerStart);
  return text.replace(CONTROL_TOKEN, " ").replace(RECIPIENT_HEADER, "").replace(CODE_FENCE, "").trim();
}

/** The text between the first "{" and the last "}", or null when there is none. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  return text.slice(start, end + 1);
}

type Json = { ok: true; value: unknown; repaired: boolean } | { ok: false };

function parseJson(text: string): Json {
  try {
    return { ok: true, value: JSON.parse(text), repaired: false };
  } catch {
    // Trailing commas are the most common slip in hand-written JSON.
    const relaxed = text.replace(/,\s*([}\]])/g, "$1");
    if (relaxed === text) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(relaxed), repaired: true };
    } catch {
      return { ok: false };
    }
  }
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

const MAX_CANDIDATES = 24;

/**
 * The outermost braces first. When they do not parse (text with braces around the answer, or two
 * objects), each balanced object is tried in order and the first that looks like a card wins.
 */
function parseCardJson(text: string, outer: string): Json {
  const direct = parseJson(outer);
  if (direct.ok) return direct;
  let firstObject: Json | null = null;
  let from = 0;
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const start = text.indexOf("{", from);
    if (start < 0) break;
    from = start + 1;
    const end = matchingBrace(text, start);
    if (end < 0) continue;
    const parsed = parseJson(text.slice(start, end + 1));
    if (!parsed.ok || !isRecord(parsed.value)) continue;
    if (hasCardKey(parsed.value)) return { ok: true, value: parsed.value, repaired: true };
    firstObject ??= { ok: true, value: parsed.value, repaired: true };
  }
  return firstObject ?? { ok: false };
}

// Clamping

type Rec = Record<string, unknown>;

interface State {
  changed: boolean;
}

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCardKey(value: Rec): boolean {
  return CARD_KEY_ORDER.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** null, false and "" mean the model left an optional field out. */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === false || value === "";
}

/** Drops C0 controls (except tab and line breaks), DEL and bidi overrides. */
function dropControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0x7f) continue;
    if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue;
    out += ch;
  }
  return out;
}

/** A single-line string from a string or a number, or undefined when blank. */
function textOf(value: unknown, st: State): string | undefined {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isFinite(value)) {
    text = String(value);
    st.changed = true;
  } else {
    if (!isAbsent(value)) st.changed = true;
    return undefined;
  }
  return dropControls(text).replace(/\s+/g, " ").trim() || undefined;
}

function segmentLang(text: string): string {
  const script = scriptLangOf(text);
  return script === "zh-Hans" ? "zh" : script;
}

function fit(text: string, cap: number, lang: string | undefined, st: State): string {
  if (widthOf(text) <= cap) return text;
  st.changed = true;
  return clipToWidth(text, cap, lang);
}

function enumKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function pick<T extends string>(
  value: unknown,
  values: readonly T[],
  synonyms: ReadonlyMap<string, T>,
  fallback: T,
  st: State,
): T {
  const known = values as readonly string[];
  if (typeof value === "string" && known.includes(value)) return value as T;
  st.changed = true;
  if (typeof value !== "string") return fallback;
  const key = enumKey(value);
  if (known.includes(key)) return key as T;
  return synonyms.get(key) ?? fallback;
}

function trueOf(value: unknown, st: State): boolean {
  if (value === true) return true;
  if (typeof value === "string" && enumKey(value) === "true") {
    st.changed = true;
    return true;
  }
  if (!isAbsent(value)) st.changed = true;
  return false;
}

const HEARD_SYNONYMS: ReadonlyMap<string, Heard> = new Map<string, Heard>([
  ["good", "clear"],
  ["clean", "clear"],
  ["high", "clear"],
  ["ok", "clear"],
  ["okay", "clear"],
  ["partly", "partial"],
  ["some", "partial"],
  ["medium", "partial"],
  ["mixed", "partial"],
  ["fair", "partial"],
  ["mostly", "partial"],
  ["bad", "poor"],
  ["low", "poor"],
  ["unclear", "poor"],
  ["noisy", "poor"],
  ["muffled", "poor"],
  ["hard", "poor"],
  ["weak", "poor"],
  ["no_speech", "none"],
  ["nospeech", "none"],
  ["silence", "none"],
  ["silent", "none"],
  ["no_audio", "none"],
  ["nothing", "none"],
  ["empty", "none"],
]);

const ASK_TO_SYNONYMS: ReadonlyMap<string, AskTo> = new Map<string, AskTo>([
  ["listener", "you"],
  ["user", "you"],
  ["everyone", "room"],
  ["everybody", "room"],
  ["all", "room"],
  ["group", "room"],
  ["audience", "room"],
  ["class", "room"],
  ["team", "room"],
  ["the_room", "room"],
  ["mention", "mentioned"],
  ["named", "mentioned"],
  ["nobody", "none"],
  ["no_one", "none"],
  ["noone", "none"],
  ["nothing", "none"],
  ["n/a", "none"],
]);

const SAY_LANG_SYNONYMS: ReadonlyMap<string, SayLang> = new Map<string, SayLang>([
  ["english", "en"],
  ["eng", "en"],
  ["en_us", "en"],
  ["en_gb", "en"],
  ["en_au", "en"],
  ["en_ca", "en"],
  ["japanese", "ja"],
  ["jp", "ja"],
  ["jpn", "ja"],
  ["ja_jp", "ja"],
  ["日本語", "ja"],
  ["chinese", "zh"],
  ["mandarin", "zh"],
  ["zh_cn", "zh"],
  ["zh_hans", "zh"],
  ["zh_sg", "zh"],
  ["zh_tw", "zh"],
  ["zh_hant", "zh"],
  ["zh_hk", "zh"],
  ["cmn", "zh"],
  ["zho", "zh"],
  ["chi", "zh"],
  ["cn", "zh"],
  ["中文", "zh"],
  ["普通话", "zh"],
]);

const FACT_KIND_SYNONYMS: ReadonlyMap<string, FactKind> = new Map<string, FactKind>([
  ["person", "name"],
  ["people", "name"],
  ["who", "name"],
  ["speaker", "name"],
  ["organization", "name"],
  ["organisation", "name"],
  ["org", "name"],
  ["company", "name"],
  ["time", "date"],
  ["datetime", "date"],
  ["date_time", "date"],
  ["deadline", "date"],
  ["day", "date"],
  ["when", "date"],
  ["schedule", "date"],
  ["num", "number"],
  ["amount", "number"],
  ["price", "number"],
  ["cost", "number"],
  ["quantity", "number"],
  ["percent", "number"],
  ["percentage", "number"],
  ["figure", "number"],
  ["money", "number"],
  ["count", "number"],
  ["location", "place"],
  ["address", "place"],
  ["venue", "place"],
  ["where", "place"],
  ["room", "place"],
  ["action", "task"],
  ["action_item", "task"],
  ["todo", "task"],
  ["to_do", "task"],
  ["assignment", "task"],
  ["homework", "task"],
  ["request", "task"],
  ["concept", "term"],
  ["keyword", "term"],
  ["word", "term"],
  ["topic", "term"],
  ["jargon", "term"],
  ["other", "term"],
]);

const ENGLISH_WORD =
  /\b(?:the|and|to|of|is|are|was|were|you|we|they|it|this|that|can|could|will|would|at|on|in|for|with|just|check|let's|okay|what|who|when|where|sorry|please)\b/i;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Latin letters clearly outweigh CJK characters and a common English word is present. */
export function readsAsEnglish(text: string): boolean {
  let latin = 0;
  let cjk = 0;
  for (const ch of text) {
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) latin++;
    else if (CJK_CHAR.test(ch)) cjk++;
  }
  return latin > 0 && latin >= cjk * 2 && ENGLISH_WORD.test(text);
}

function inferSayLang(text: string): SayLang {
  if (/\p{Script=Hangul}/u.test(text)) return "other";
  const script = scriptLangOf(text);
  if (script === "ja") return "ja";
  if (script === "zh-Hans") return "zh";
  return readsAsEnglish(text) ? "en" : "other";
}

function sayLangOf(value: unknown, text: string, st: State): SayLang {
  const known = SAY_LANGS as readonly string[];
  if (typeof value === "string" && known.includes(value)) return value as SayLang;
  st.changed = true;
  if (typeof value === "string") {
    const key = enumKey(value);
    if (known.includes(key)) return key as SayLang;
    const hit = SAY_LANG_SYNONYMS.get(key);
    if (hit) return hit;
  }
  return inferSayLang(text);
}

function factOf(value: unknown, ctx: ClampContext, st: State): Fact | null {
  let rec: Rec;
  if (isRecord(value)) rec = value;
  else if (typeof value === "string" || typeof value === "number") {
    st.changed = true;
    rec = { text: value };
  } else return null;
  const text = textOf(rec.text, st);
  if (!text) return null;
  const fact: Fact = {
    kind: pick(rec.kind, FACT_KINDS, FACT_KIND_SYNONYMS, "term", st),
    text: fit(text, CAPS.factText, segmentLang(text), st),
  };
  const note = textOf(rec.note, st);
  if (note) fact.note = fit(note, CAPS.factNote, ctx.cardLang, st);
  if (trueOf(rec.unsure, st)) fact.unsure = true;
  return fact;
}

/** A card wrapped in one key, such as {"card": {...}}, is unwrapped. */
function unwrapCard(input: unknown, st: State): Rec | null {
  if (!isRecord(input)) return null;
  if (hasCardKey(input)) return input;
  for (const value of Object.values(input)) {
    if (isRecord(value) && hasCardKey(value)) {
      st.changed = true;
      return value;
    }
  }
  return input;
}

/**
 * Turns any parsed JSON into a valid CardBody by clamping instead of rejecting.
 * Unknown enums fall to safe values (ask.to none, heard partial, kind term), strings are clipped
 * to CAPS with clipToWidth, facts cut to 5, summary to 2, false booleans dropped, gloss dropped
 * when say.lang equals ctx.cardLang, a missing ask.text is taken from the quote (or ask.to falls
 * to none), and heard none forces ask.to none, no say, no facts and one summary sentence. heard
 * poor with no say gets the repeat line, say { text: repeatLine(ctx.meetingLang), lang:
 * ctx.meetingLang } plus gloss repeatLine(ctx.cardLang) when the two languages differ. quality is
 * "clean" when nothing had to change. Returns null only when no summary text can be found at all.
 */
export function clampCardBody(
  input: unknown,
  ctx: ClampContext,
): { body: CardBody; quality: "clean" | "clamped" } | null {
  try {
    return clamp(input, ctx);
  } catch {
    return null; // never reached by any known input, but a clamp must not throw
  }
}

function clamp(input: unknown, ctx: ClampContext): { body: CardBody; quality: "clean" | "clamped" } | null {
  const st: State = { changed: false };
  const src = unwrapCard(input, st);
  if (!src) return null;

  const heard = pick(src.heard, HEARD_VALUES, HEARD_SYNONYMS, "partial", st);
  const quoteText = textOf(src.quote, st);
  const quote = quoteText === undefined ? undefined : fit(quoteText, CAPS.quote, segmentLang(quoteText), st);

  // ask
  let askSrc: Rec;
  if (isRecord(src.ask)) askSrc = src.ask;
  else {
    st.changed = true;
    askSrc = typeof src.ask === "string" ? { to: src.ask } : {};
  }
  let to = pick(askSrc.to, ASK_TO_VALUES, ASK_TO_SYNONYMS, "none", st);
  let askText = textOf(askSrc.text, st);
  let askBy = textOf(askSrc.by, st);
  if (heard === "none" && to !== "none") {
    to = "none";
    st.changed = true;
  }
  if (to !== "none" && !askText) {
    st.changed = true;
    if (quote) askText = quote;
    else to = "none";
  }
  if (to === "none") {
    if (askText || askBy) st.changed = true;
    askText = undefined;
    askBy = undefined;
  }
  const ask: Ask = { to };
  if (askText) ask.text = fit(askText, CAPS.askText, ctx.cardLang, st);
  if (askBy) ask.by = fit(askBy, CAPS.askBy, segmentLang(askBy), st);

  // say
  let say: Say | undefined;
  const saySrc = src.say;
  if (heard === "none") {
    if (!isAbsent(saySrc)) st.changed = true;
  } else if (typeof saySrc === "string" || isRecord(saySrc)) {
    if (typeof saySrc === "string") st.changed = true;
    const rec: Rec = typeof saySrc === "string" ? { text: saySrc } : saySrc;
    const text = textOf(rec.text, st);
    if (!text) st.changed = true;
    else {
      const lang = sayLangOf(rec.lang, text, st);
      say = { text: fit(text, CAPS.sayText, lang === "other" ? segmentLang(text) : lang, st), lang };
      const gloss = textOf(rec.gloss, st);
      if (gloss && lang === ctx.cardLang) st.changed = true;
      else if (gloss) say.gloss = fit(gloss, CAPS.sayGloss, ctx.cardLang, st);
    }
  } else if (!isAbsent(saySrc)) st.changed = true;
  if (!say && heard === "poor") {
    st.changed = true;
    say = { text: repeatLine(ctx.meetingLang), lang: ctx.meetingLang };
    if (ctx.meetingLang !== ctx.cardLang) say.gloss = repeatLine(ctx.cardLang);
  }

  // summary
  let lines: string[] = [];
  const summarySrc = src.summary;
  if (Array.isArray(summarySrc)) {
    for (const item of summarySrc) {
      const line = textOf(item, st);
      if (line) lines.push(line);
      else st.changed = true;
    }
  } else {
    st.changed = true;
    const line = textOf(summarySrc, st);
    if (line) lines.push(line);
  }
  if (lines.length > MAX_SUMMARY) {
    lines = lines.slice(0, MAX_SUMMARY);
    st.changed = true;
  }
  if (lines.length === 1 && widthOf(lines[0]) > CAPS.summaryGlance) {
    const [first, rest] = splitFirstSentence(lines[0], ctx.cardLang);
    if (rest) {
      lines = [first, rest];
      st.changed = true;
    }
  }
  if (heard === "none" && lines.length > 0) {
    const [first, rest] = splitFirstSentence(lines[0], ctx.cardLang);
    if (rest || lines.length > 1) st.changed = true;
    lines = [first];
  }
  if (lines.length === 0) {
    st.changed = true;
    const fallback = heard === "none" ? localString(ctx.cardLang, "noSpeech") : (ask.text ?? quote);
    if (!fallback) return null;
    lines = [fallback];
  }
  const glance = fit(lines[0], CAPS.summaryGlance, ctx.cardLang, st);
  const summary: Summary =
    lines.length > 1 ? [glance, fit(lines[1], CAPS.summaryContext, ctx.cardLang, st)] : [glance];

  // facts
  let facts: Fact[] = [];
  const factsSrc = src.facts;
  if (Array.isArray(factsSrc)) {
    for (const item of factsSrc) {
      const fact = factOf(item, ctx, st);
      if (fact) facts.push(fact);
      else st.changed = true;
    }
  } else if (!isAbsent(factsSrc)) st.changed = true;
  if (facts.length > MAX_FACTS) {
    facts = facts.slice(0, MAX_FACTS);
    st.changed = true;
  }
  if (heard === "none" && facts.length > 0) {
    facts = [];
    st.changed = true;
  }

  const earlier = trueOf(src.earlier, st);

  const body: CardBody = {
    heard,
    ask,
    ...(say ? { say } : {}),
    summary,
    facts,
    ...(quote ? { quote } : {}),
    ...(earlier ? { earlier: true as const } : {}),
  };
  if (!CardBody.safeParse(body).success) return null;
  return { body, quality: st.changed ? "clamped" : "clean" };
}

// Teen and tens backstop

// Two digits standing alone, not part of a longer number, a decimal or a clock time.
const TWO_DIGITS = /(?<![\d０-９.,．，:：])([\d０-９]{2})(?![\d０-９]|[.,．，:：][\d０-９])/g;
const FULLWIDTH_ZERO = 0xff10;

const NUMBER_WORDS: Readonly<Record<number, string>> = {
  13: "thirteen",
  14: "fourteen",
  15: "fifteen",
  16: "sixteen",
  17: "seventeen",
  18: "eighteen",
  19: "nineteen",
  30: "thirty",
  40: "forty",
  50: "fifty",
  60: "sixty",
  70: "seventy",
  80: "eighty",
  90: "ninety",
};

function digitValue(digits: string): number {
  let n = 0;
  for (const ch of digits) {
    const cp = ch.codePointAt(0) ?? 0;
    n = n * 10 + (cp >= FULLWIDTH_ZERO ? cp - FULLWIDTH_ZERO : cp - 48);
  }
  return n;
}

function sameDigits(n: number, like: string): string {
  const ascii = String(n);
  if ((like.codePointAt(0) ?? 0) < FULLWIDTH_ZERO) return ascii;
  return [...ascii].map((d) => String.fromCodePoint(FULLWIDTH_ZERO + Number(d))).join("");
}

/** 13 to 19 pair with 30 to 90 and back (15 and 50, 13 and 30). */
export function teenTensPair(n: number): number | null {
  if (n >= 13 && n <= 19) return (n - 10) * 10;
  if (n >= 30 && n <= 90 && n % 10 === 0) return n / 10 + 10;
  return null;
}

function mentions(text: string | undefined, n: number): boolean {
  if (!text) return false;
  for (const m of text.matchAll(TWO_DIGITS)) if (digitValue(m[1]) === n) return true;
  return new RegExp(`\\b${NUMBER_WORDS[n]}\\b`, "i").test(text);
}

function pairNote(alt: string, lang: CardLang): string {
  if (lang === "ja") return `または${alt}`;
  if (lang === "zh") return `也可能是${alt}`;
  return `or ${alt}`;
}

function addPairNote(note: string | undefined, pair: string, lang: CardLang): string {
  if (!note) return clipToWidth(pair, CAPS.factNote, lang);
  const wrap = (inner: string) => (lang === "en" ? `${inner} (${pair})` : `${inner}（${pair}）`);
  const joined = wrap(note);
  if (widthOf(joined) <= CAPS.factNote) return joined;
  const room = CAPS.factNote - (widthOf(joined) - widthOf(note));
  return room >= 6 ? wrap(clipToWidth(note, room, lang)) : clipToWidth(pair, CAPS.factNote, lang);
}

const KANA_CHAR = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN_CHAR = /\p{Script=Han}/u;

/** The card language a body reads in, from the script of its meaning fields. */
function cardLangOfBody(body: CardBody): CardLang {
  let latin = 0;
  let kana = 0;
  let han = 0;
  for (const ch of [...body.summary, body.ask.text ?? "", body.say?.gloss ?? ""].join(" ")) {
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) latin++;
    else if (KANA_CHAR.test(ch)) kana++;
    else if (HAN_CHAR.test(ch)) han++;
  }
  if ((kana + han) * 2 <= latin) return "en";
  return kana > 0 ? "ja" : "zh";
}

/**
 * Teen and tens backstop. When say.lang is en or the quote reads as English, a number fact that
 * holds 13 to 19 or a round 30 to 90 gets unsure and the paired reading in note (15 and 50,
 * 13 and 30) unless the model already did it. The note is written in the card language, read
 * from the script of the summary.
 */
export function applyNumberBackstop(body: CardBody): CardBody {
  return backstop(body, cardLangOfBody(body));
}

function backstop(body: CardBody, noteLang: CardLang): CardBody {
  const english = body.say?.lang === "en" || (body.quote !== undefined && readsAsEnglish(body.quote));
  if (!english) return body;
  let changed = false;
  const facts = body.facts.map((fact): Fact => {
    if (fact.kind !== "number") return fact;
    const pairs: number[] = [];
    const alt = fact.text.replace(TWO_DIGITS, (digits: string) => {
      const pair = teenTensPair(digitValue(digits));
      if (pair === null) return digits;
      pairs.push(pair);
      return sameDigits(pair, digits);
    });
    if (pairs.length === 0) return fact;
    const paired = pairs.every((p) => mentions(fact.text, p) || mentions(fact.note, p));
    if (paired && fact.unsure) return fact;
    changed = true;
    const next: Fact = { ...fact, unsure: true };
    if (!paired) next.note = addPairNote(fact.note, pairNote(alt, noteLang), noteLang);
    return next;
  });
  return changed ? { ...body, facts } : body;
}

/** stripModelText, extractJsonObject, JSON.parse, clampCardBody, then applyNumberBackstop. */
export function parseCardText(raw: string, ctx: ClampContext): ParseOutcome {
  const text = stripModelText(raw);
  if (!text) return { ok: false, reason: "empty" };
  const outer = extractJsonObject(text);
  if (outer === null) return { ok: false, reason: text.includes("{") ? "bad_json" : "no_json" }; // cut off mid-object
  const parsed = parseCardJson(text, outer);
  if (!parsed.ok) return { ok: false, reason: "bad_json" };
  const clamped = clampCardBody(parsed.value, ctx);
  if (!clamped) return { ok: false, reason: "not_card" };
  return {
    ok: true,
    body: backstop(clamped.body, ctx.cardLang),
    quality: parsed.repaired ? "clamped" : clamped.quality,
  };
}

/** Cuts text to at most max UTF-16 units without splitting a code point, ending with "…" when cut. */
function cutToLength(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/**
 * The Unformatted card body. heard partial, ask.to none, no say, no facts, and the cleaned raw
 * text (at most UNFORMATTED_MAX_CHARS) in summary[0]. The server sets meta.unformatted.
 */
export function unformattedBody(raw: string, ctx: ClampContext): CardBody {
  const cleaned = dropControls(stripModelText(raw))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text = cleaned ? cutToLength(cleaned, UNFORMATTED_MAX_CHARS) : localString(ctx.cardLang, "noSpeech");
  return { heard: "partial", ask: { to: "none" }, summary: [text], facts: [] };
}
