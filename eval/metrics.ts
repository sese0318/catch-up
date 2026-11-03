// Pure scoring for the eval. No I/O, so tests can feed it recorded or hand-made results.
// Recall looks only at the card's facts, because that is where the card promises names, numbers and dates.
import { LIVE_ROUTE_LABELS, type AskTo, type CardBody, type CardLang, type Fact } from "@/lib/card/schema";
import type { ErrorData, RoutePreference, StageName, WireCard } from "@/lib/protocol";
import type { EvalClip, Gold, GoldDate, GoldName, GoldNumber } from "./clips";

// Records

/** One press as the runner saw it. Holds the card as received, never audio. */
export interface PressRecord {
  clipId: string;
  route: RoutePreference; // the route the press asked for
  run: number; // 1-based pass number
  cardLang: CardLang;
  sentSec: number;
  bytes: number;
  httpStatus: number | null;
  stages: { name: StageName; atMs: number }[];
  firstTokenMs: number | null; // request start to the writing stage, as the runner saw it
  cardMs: number | null; // request start to the card event
  totalMs: number;
  card: WireCard | null;
  error: ErrorData | null;
  failure: string | null; // a runner or protocol problem, never content
  invalidEvents: number;
}

// Text helpers

const LATIN_ACCENTED = /[À-ɏ]/g;

/** Lowercase, full-width folded, accents and spacing and punctuation dropped, katakana as hiragana. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(LATIN_ACCENTED, (ch) => ch.normalize("NFD").replace(/[̀-ͯ]/g, ""))
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

const CJK_DIGIT: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CJK_UNIT: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };
const CJK_BIG: Readonly<Record<string, number>> = { 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 };
// A run with at least one CJK numeral, which may mix in ASCII digits as in 4.2万 or 3千6百.
const CJK_NUMERAL_RUN = /(?:\d+(?:\.\d+)?)?[零〇一二两兩三四五六七八九十百千万萬亿億](?:[零〇一二两兩三四五六七八九十百千万萬亿億]|\d+(?:\.\d+)?)*/g;

/** Value of a run of Chinese or Japanese numerals such as 三千六百, 十五, 二〇二六 or 4.2万. */
export function parseCjkNumeral(run: string): number | null {
  const tokens = run.match(/\d+(?:\.\d+)?|[^\d.]/g) ?? [];
  if (tokens.length === 0) return null;
  const hasUnit = tokens.some((t) => t in CJK_UNIT || t in CJK_BIG);
  if (!hasUnit) {
    if (!tokens.every((t) => t in CJK_DIGIT || /^\d+$/.test(t))) return null;
    return Number(tokens.map((t) => (t in CJK_DIGIT ? CJK_DIGIT[t] : t)).join(""));
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const t of tokens) {
    if (/^\d/.test(t)) digit = Number(t);
    else if (t in CJK_DIGIT) digit = CJK_DIGIT[t];
    else if (t in CJK_UNIT) {
      section += (digit || 1) * CJK_UNIT[t];
      digit = 0;
    } else if (t in CJK_BIG) {
      total += (section + digit || 1) * CJK_BIG[t];
      section = 0;
      digit = 0;
    } else return null;
  }
  return Math.round((total + section + digit) * 1e6) / 1e6;
}

/** NFKC plus CJK numerals written as digits, so one set of patterns reads every script. */
function digitsText(text: string): string {
  return text.normalize("NFKC").replace(CJK_NUMERAL_RUN, (run) => {
    const value = parseCjkNumeral(run);
    return value === null ? run : String(value);
  });
}

const ONES: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ORDINALS: Readonly<Record<string, number>> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};
const SCALES: Readonly<Record<string, number>> = { hundred: 100, thousand: 1000, million: 1_000_000 };

/** Numbers written as English words, for example forty-two thousand or three hundred and twelve. */
export function englishNumberWords(text: string): number[] {
  const out: number[] = [];
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  let total = 0;
  let current = 0;
  let open = false;
  const flush = () => {
    if (open) out.push(total + current);
    total = 0;
    current = 0;
    open = false;
  };
  for (const word of words) {
    if (word in ONES) {
      current += ONES[word];
      open = true;
    } else if (word in TENS) {
      current += TENS[word];
      open = true;
    } else if (word in ORDINALS) {
      current += ORDINALS[word];
      open = true;
      flush();
    } else if (word in SCALES && open) {
      const scale = SCALES[word];
      if (scale === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * scale;
        current = 0;
      }
    } else if (word === "and" && open) {
      continue;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

const SCALE_SUFFIX: Readonly<Record<string, number>> = {
  k: 1000, thousand: 1000, million: 1_000_000, 万: 1e4, 萬: 1e4, 千: 1000, 亿: 1e8, 億: 1e8,
};

/** Every number in a text, from digits, CJK numerals and English number words. */
export function extractNumbers(text: string): number[] {
  const t = digitsText(text.replace(/百分之/g, ""));
  const out: number[] = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*(k|thousand|million|万|萬|千|亿|億))?(?:st|nd|rd|th)?(?![a-z])/gi;
  for (const m of t.matchAll(re)) {
    let value = Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
    const scale = m[3] ? SCALE_SUFFIX[m[3].toLowerCase()] : undefined;
    if (scale) value *= scale;
    if (Number.isFinite(value)) out.push(value);
  }
  for (const value of englishNumberWords(t)) out.push(value);
  return out;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_WORD = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

export interface MonthDay {
  month: number;
  day: number;
  year?: number;
}

function monthDay(month: number, day: number, year?: number): MonthDay | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year === undefined ? { month, day } : { month, day, year };
}

/** Calendar dates in a text. A weekday or "the 13th" without a month is not a resolved date. */
export function extractDates(text: string): MonthDay[] {
  const t = digitsText(text);
  const out: MonthDay[] = [];
  const push = (d: MonthDay | null) => {
    if (d) out.push(d);
  };
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) push(monthDay(Number(m[2]), Number(m[3]), Number(m[1])));
  for (const m of t.matchAll(/(?<![\d-])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g)) {
    const year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : undefined;
    push(monthDay(Number(m[1]), Number(m[2]), year));
  }
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_WORD}\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4})\\b)?`, "gi"))) {
    push(monthDay(MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]), m[3] ? Number(m[3]) : undefined));
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}\\b`, "gi"))) {
    push(monthDay(MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1])));
  }
  for (const m of t.matchAll(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]/g)) {
    push(monthDay(Number(m[2]), Number(m[3]), m[1] ? Number(m[1]) : undefined));
  }
  return out;
}

const PM_WORDS = /^(p\.?m\.?|午後|下午|晚上|傍晚|夜)$/i;
const AM_WORDS = /^(a\.?m\.?|午前|上午|早上|早晨|朝)$/i;

function clockReadings(hour: number, minute: number, marker: string | undefined): number[] {
  if (hour > 24 || minute > 59) return [];
  if (marker && PM_WORDS.test(marker)) return [((hour % 12) + 12) * 60 + minute];
  if (marker && AM_WORDS.test(marker)) return [(hour % 12) * 60 + minute];
  if (marker === "中午") return [(hour < 6 ? hour + 12 : hour) * 60 + minute];
  if (hour >= 1 && hour < 12) return [hour * 60 + minute, (hour + 12) * 60 + minute];
  return [(hour % 24) * 60 + minute];
}

/** Clock times in a text as minutes after midnight. A time without am or pm gives both readings. */
export function extractTimes(text: string): number[] {
  const t = digitsText(text);
  const out: number[] = [];
  for (const m of t.matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?!\d)\s*(a\.?m\.?|p\.?m\.?)?/gi)) {
    out.push(...clockReadings(Number(m[1]), Number(m[2]), m[3]));
  }
  for (const m of t.matchAll(/(?<![\d:.])(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi)) out.push(...clockReadings(Number(m[1]), 0, m[2]));
  if (/\bnoon\b/i.test(t)) out.push(12 * 60);
  for (const m of t.matchAll(/(午前|午後)?\s*(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分|(半))?/g)) {
    out.push(...clockReadings(Number(m[2]), m[4] ? 30 : m[3] ? Number(m[3]) : 0, m[1]));
  }
  for (const m of t.matchAll(/(上午|早上|早晨|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[点點](?:\s*(\d{1,2})\s*分?|(半)|(一刻)|(三刻))?/g)) {
    const minute = m[4] ? 30 : m[5] ? 15 : m[6] ? 45 : m[3] ? Number(m[3]) : 0;
    out.push(...clockReadings(Number(m[2]), minute, m[1]));
  }
  return out;
}

function minutesOf(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + m;
}

/** The likely mishearing of a teen or a round tens number (15 against 50). */
export function confusablePair(value: number): number | null {
  if (Number.isInteger(value) && value >= 13 && value <= 19) return (value - 10) * 10;
  if (Number.isInteger(value) && value >= 30 && value <= 90 && value % 10 === 0) return value / 10 + 10;
  return null;
}

/** Which language a line of card text is written in, judged by script. CJK characters weigh 2. */
export function scriptLangOf(text: string): CardLang | "unknown" {
  const kana = (text.match(/[぀-ヿ]/g) ?? []).length;
  const han = (text.match(/[㐀-䶿一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if ((kana + han) * 2 > latin) return kana > 0 ? "ja" : han > 0 ? "zh" : "unknown";
  return latin > 0 ? "en" : "unknown";
}

// Card scoring

export interface Recall {
  hit: number;
  total: number;
  missed: string[];
}

export interface CardScore {
  askTo: AskTo;
  askCorrect: boolean;
  falseAlarm: boolean; // Asked you when the script asked someone else or no one
  miss: boolean; // not Asked you when the script asked the listener
  heardOk: boolean;
  sayOk: boolean; // the say line is there or left out as the script expects
  sayLangOk: boolean | null; // null when there is no say line or no expected language
  cardLangOk: boolean;
  names: Recall;
  numbers: Recall;
  dates: Recall;
  terms: Recall;
  confusable: { flagged: number; found: number }; // teen and tens numbers marked unsure when found
  facts: number;
}

function factHay(fact: Fact): string {
  return `${fact.text} ${fact.note ?? ""}`;
}

function recallOf<T>(gold: readonly T[], label: (g: T) => string, hit: (g: T) => boolean): Recall {
  const missed = gold.filter((g) => !hit(g)).map(label);
  return { hit: gold.length - missed.length, total: gold.length, missed };
}

function nameHit(gold: GoldName, facts: readonly Fact[]): boolean {
  const hay = facts.map((f) => normalizeForMatch(factHay(f)));
  const forms = [gold.text, ...gold.alts].map(normalizeForMatch).filter((f) => f.length > 0);
  return forms.some((form) => hay.some((h) => h.includes(form)));
}

function numbersIn(facts: readonly Fact[]): { fact: Fact; values: number[] }[] {
  return facts.filter((f) => f.kind !== "date").map((fact) => ({ fact, values: extractNumbers(factHay(fact)) }));
}

function numberHit(gold: GoldNumber, facts: readonly Fact[]): boolean {
  return numbersIn(facts).some(({ values }) => values.includes(gold.value));
}

function dateHit(gold: GoldDate, facts: readonly Fact[]): boolean {
  const [year, month, day] = gold.date.split("-").map(Number);
  const dated = facts.some((f) =>
    extractDates(factHay(f)).some((d) => d.month === month && d.day === day && (d.year === undefined || d.year === year)),
  );
  if (!dated || !gold.time) return dated;
  const want = minutesOf(gold.time);
  return facts.some((f) => extractTimes(factHay(f)).includes(want));
}

export function scoreCard(card: CardBody, gold: Gold, cardLang: CardLang): CardScore {
  const facts = card.facts;
  const confusable = { flagged: 0, found: 0 };
  for (const g of gold.numbers.filter((n) => n.confusable)) {
    const pair = confusablePair(g.value);
    const holder = numbersIn(facts).find(({ values }) => values.includes(g.value) || (pair !== null && values.includes(pair)));
    if (!holder) continue;
    confusable.found += 1;
    if (holder.fact.unsure) confusable.flagged += 1;
  }
  const say = card.say;
  return {
    askTo: card.ask.to,
    askCorrect: card.ask.to === gold.askTo,
    falseAlarm: card.ask.to === "you" && gold.askTo !== "you",
    miss: gold.askTo === "you" && card.ask.to !== "you",
    heardOk: gold.heard.includes(card.heard),
    sayOk: gold.say === "any" || (gold.say === "expected" ? say !== undefined : say === undefined),
    sayLangOk: say && gold.sayLang ? say.lang === gold.sayLang : null,
    cardLangOk: scriptLangOf(card.summary[0]) === cardLang,
    names: recallOf(gold.names, (g) => g.text, (g) => nameHit(g, facts)),
    numbers: recallOf(gold.numbers, (g) => g.said, (g) => numberHit(g, facts)),
    dates: recallOf(gold.dates, (g) => g.said, (g) => dateHit(g, facts)),
    terms: recallOf(gold.terms, (g) => g.text, (g) => nameHit(g, facts)),
    confusable,
    facts: facts.length,
  };
}

// Route summaries

export interface Rate {
  num: number;
  den: number;
}

export interface Percentiles {
  p50: number | null;
  p95: number | null;
  n: number;
}

export interface ClipRow {
  clipId: string;
  scene: string;
  askTo: AskTo;
  predicted: (AskTo | "error")[];
  recall: Rate;
}

export interface RouteSummary {
  route: RoutePreference;
  label: string;
  models: string[];
  presses: number;
  cards: number;
  errors: number;
  errorCodes: Record<string, number>;
  unknownClips: number;
  firstToken: Percentiles;
  fullCard: Percentiles;
  askedYou: Rate; // the Asked you banner shown exactly when the script asks the listener
  askState: Rate; // all four ask states
  falseAlarms: Rate;
  misses: Rate;
  nameRecall: Rate;
  numberRecall: Rate;
  dateRecall: Rate;
  termRecall: Rate;
  validJsonFirstTry: Rate;
  cleanJson: Rate;
  unformatted: Rate;
  fallbacks: Rate;
  heard: Rate;
  sayAsExpected: Rate;
  sayLang: Rate;
  cardLang: Rate;
  confusableFlagged: Rate;
  clips: ClipRow[];
}

/** Nearest-rank percentile, null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function percentiles(values: readonly number[]): Percentiles {
  return { p50: percentile(values, 50), p95: percentile(values, 95), n: values.length };
}

export const ROUTE_TITLES: Readonly<Record<RoutePreference, string>> = {
  open_weights: LIVE_ROUTE_LABELS.open_weights,
  meta_api: LIVE_ROUTE_LABELS.meta_api,
  auto: "Auto, Muse Spark Open first and the Meta Model API once as backup",
  mock: "Mock, no model was called",
};

const rate = (): Rate => ({ num: 0, den: 0 });
const add = (r: Rate, ok: boolean) => {
  r.den += 1;
  if (ok) r.num += 1;
};
const addRecall = (r: Rate, recall: Recall) => {
  r.num += recall.hit;
  r.den += recall.total;
};

/** Scores every press of one route against the scripts. */
export function summarizeRoute(route: RoutePreference, records: readonly PressRecord[], clips: readonly EvalClip[]): RouteSummary {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const s: RouteSummary = {
    route,
    label: ROUTE_TITLES[route],
    models: [],
    presses: 0,
    cards: 0,
    errors: 0,
    errorCodes: {},
    unknownClips: 0,
    firstToken: percentiles([]),
    fullCard: percentiles([]),
    askedYou: rate(),
    askState: rate(),
    falseAlarms: rate(),
    misses: rate(),
    nameRecall: rate(),
    numberRecall: rate(),
    dateRecall: rate(),
    termRecall: rate(),
    validJsonFirstTry: rate(),
    cleanJson: rate(),
    unformatted: rate(),
    fallbacks: rate(),
    heard: rate(),
    sayAsExpected: rate(),
    sayLang: rate(),
    cardLang: rate(),
    confusableFlagged: rate(),
    clips: [],
  };
  const firstTokens: number[] = [];
  const fullCards: number[] = [];
  const models = new Set<string>();
  const rows = new Map<string, ClipRow>();

  for (const record of records) {
    const clip = byId.get(record.clipId);
    if (!clip) {
      s.unknownClips += 1;
      continue;
    }
    s.presses += 1;
    let row = rows.get(clip.id);
    if (!row) {
      row = { clipId: clip.id, scene: clip.scene, askTo: clip.gold.askTo, predicted: [], recall: rate() };
      rows.set(clip.id, row);
    }
    const card = record.card;
    if (!card) {
      s.errors += 1;
      const code = record.error?.code ?? record.failure ?? "no_card";
      s.errorCodes[code] = (s.errorCodes[code] ?? 0) + 1;
      row.predicted.push("error");
      continue;
    }
    s.cards += 1;
    models.add(card.meta.model);
    if (record.firstTokenMs !== null) firstTokens.push(record.firstTokenMs);
    if (record.cardMs !== null) fullCards.push(record.cardMs);

    const score = scoreCard(card, clip.gold, record.cardLang);
    row.predicted.push(score.askTo);
    add(s.askedYou, (score.askTo === "you") === (clip.gold.askTo === "you"));
    add(s.askState, score.askCorrect);
    if (clip.gold.askTo === "you") add(s.misses, score.miss);
    else add(s.falseAlarms, score.falseAlarm);
    addRecall(s.nameRecall, score.names);
    addRecall(s.numberRecall, score.numbers);
    addRecall(s.dateRecall, score.dates);
    addRecall(s.termRecall, score.terms);
    for (const r of [score.names, score.numbers, score.dates, score.terms]) addRecall(row.recall, r);

    const parsed = card.meta.parse !== "unformatted" && !card.meta.unformatted;
    add(s.validJsonFirstTry, parsed && card.meta.attempts === 1 && !card.meta.fallbackFrom);
    add(s.cleanJson, card.meta.parse === "clean" && !card.meta.fallbackFrom);
    add(s.unformatted, !parsed);
    add(s.fallbacks, card.meta.fallbackFrom !== undefined);
    add(s.heard, score.heardOk);
    add(s.sayAsExpected, score.sayOk);
    if (score.sayLangOk !== null) add(s.sayLang, score.sayLangOk);
    if (parsed) add(s.cardLang, score.cardLangOk);
    s.confusableFlagged.num += score.confusable.flagged;
    s.confusableFlagged.den += score.confusable.found;
  }

  s.firstToken = percentiles(firstTokens);
  s.fullCard = percentiles(fullCards);
  s.models = [...models].sort();
  s.clips = [...rows.values()];
  return s;
}

// Markdown

export function formatRate(r: Rate): string {
  if (r.den === 0) return "no data";
  return `${Math.round((r.num / r.den) * 100)}% (${r.num} of ${r.den})`;
}

export function formatSeconds(ms: number | null): string {
  return ms === null ? "no data" : `${(ms / 1000).toFixed(1)} s`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

function modelCell(s: RouteSummary): string {
  if (s.models.length === 0) return "no cards";
  return s.models.map((m) => `\`${m}\``).join(" and ");
}

export interface SummaryInput {
  generatedAt: string; // ISO time
  audio: string; // where the audio came from, for example synthetic Windows voices
  runsPerRoute: number;
  pressTime: string; // the press time the scripts assume
  realClockRoutes?: readonly RoutePreference[]; // routes whose runs used the real clock as the press time
  sources: readonly string[]; // raw files the summary was built from
  routes: readonly RouteSummary[];
}

/** The eval table for the README and the video, in plain words. */
export function renderSummaryMarkdown(input: SummaryInput): string {
  const live = input.routes.filter((r) => r.route !== "mock");
  const mock = input.routes.filter((r) => r.route === "mock");
  const out: string[] = [];
  out.push("# Catch Up eval", "");
  out.push(
    `Made ${input.generatedAt.slice(0, 10)}. Audio came from ${input.audio}. Each press sent one whole clip with the press time the scripts assume (${input.pressTime}), and every clip ran ${input.runsPerRoute} ${input.runsPerRoute === 1 ? "time" : "times"} per route.`,
    "",
  );
  if (input.realClockRoutes && input.realClockRoutes.length > 0) {
    const names = input.realClockRoutes.map((r) => `\`${r}\``).join(" and ");
    out.push(`Runs of ${names} used the real clock as the press time instead, so their date recall can differ.`, "");
  }
  out.push(
    "Times run from the request start to the event in the eval process, so they leave out the upload from a phone or laptop. First token is the Writing your card stage. Full card is the card event.",
    "",
  );

  const mainHead = [
    "Route",
    "Model",
    "Presses",
    "Errors",
    "First token p50",
    "First token p95",
    "Full card p50",
    "Full card p95",
    "Asked you accuracy",
    "False alarms",
    "Name recall",
    "Number recall",
    "Date recall",
    "Valid JSON first try",
    "Fallback rate",
  ];
  const mainRow = (s: RouteSummary) => [
    `${s.label} (\`${s.route}\`)`,
    modelCell(s),
    String(s.presses),
    String(s.errors),
    formatSeconds(s.firstToken.p50),
    formatSeconds(s.firstToken.p95),
    formatSeconds(s.fullCard.p50),
    formatSeconds(s.fullCard.p95),
    formatRate(s.askedYou),
    formatRate(s.falseAlarms),
    formatRate(s.nameRecall),
    formatRate(s.numberRecall),
    formatRate(s.dateRecall),
    formatRate(s.validJsonFirstTry),
    formatRate(s.fallbacks),
  ];

  out.push("## Live routes", "");
  if (live.length === 0) out.push("No live route has run yet. Live runs need keys in `.env.local`.", "");
  else out.push(...table(mainHead, live.map(mainRow)), "");
  out.push(
    "Asked you accuracy counts cards that show the Asked you banner exactly when the script asks the listener. False alarms counts Asked you on clips where the script asked someone else or no one. Recall counts names, numbers and dates from the script that show up in the card's facts. Valid JSON first try counts cards that parsed in exactly one provider attempt, without a retry or backup route. Older results with no attempt count remain in the denominator but are not claimed as first-try successes.",
    "",
  );

  if (live.length > 0) {
    out.push("## Quality checks", "");
    out.push(
      ...table(
        ["Route", "All four ask states", "Heard as expected", "Say line as expected", "Say language", "Card language", "Teen and tens flagged", "Term recall", "Clean JSON", "Unformatted", "Missed asks"],
        live.map((s) => [
          `\`${s.route}\``,
          formatRate(s.askState),
          formatRate(s.heard),
          formatRate(s.sayAsExpected),
          formatRate(s.sayLang),
          formatRate(s.cardLang),
          formatRate(s.confusableFlagged),
          formatRate(s.termRecall),
          formatRate(s.cleanJson),
          formatRate(s.unformatted),
          formatRate(s.misses),
        ]),
      ),
      "",
    );
    const clipIds = [...new Set(live.flatMap((s) => s.clips.map((c) => c.clipId)))];
    const scenes = new Map(live.flatMap((s) => s.clips.map((c) => [c.clipId, c] as const)));
    out.push("## Each clip", "");
    out.push(
      ...table(
        ["Clip", "Scene", "Script ask", ...live.map((s) => `\`${s.route}\` asks`), ...live.map((s) => `\`${s.route}\` recall`)],
        clipIds.map((id) => {
          const ref = scenes.get(id);
          const per = live.map((s) => s.clips.find((c) => c.clipId === id));
          return [
            `\`${id}\``,
            ref?.scene ?? "",
            ref?.askTo ?? "",
            ...per.map((c) => (c ? c.predicted.join(", ") : "not run")),
            ...per.map((c) => (c ? formatRate(c.recall) : "not run")),
          ];
        }),
      ),
      "",
    );
  }

  if (mock.length > 0) {
    out.push("## Mock smoke run", "", "No model was called. These rows only show that the eval pipeline works end to end.", "");
    out.push(...table(mainHead, mock.map(mainRow)), "");
  }

  const errors = input.routes.filter((s) => s.errors > 0);
  if (errors.length > 0) {
    out.push("## Errors", "");
    for (const s of errors) {
      const codes = Object.entries(s.errorCodes)
        .map(([code, n]) => `${code} ${n}`)
        .join(", ");
      out.push(`- \`${s.route}\` had ${s.errors} failed presses (${codes}).`);
    }
    out.push("");
  }

  out.push("## Sources", "");
  for (const source of input.sources) out.push(`- \`${source}\``);
  out.push("");
  return out.join("\n");
}
