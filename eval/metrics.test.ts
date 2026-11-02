import { describe, expect, it } from "vitest";
import type { CardBody } from "@/lib/card/schema";
import { copyRuleProblems } from "@/lib/copy-rules";
import type { ServerCardMeta, WireCard } from "@/lib/protocol";
import type { EvalClip, Gold } from "./clips";
import {
  confusablePair,
  englishNumberWords,
  extractDates,
  extractNumbers,
  extractTimes,
  formatRate,
  normalizeForMatch,
  parseCjkNumeral,
  percentile,
  renderSummaryMarkdown,
  scoreCard,
  scriptLangOf,
  summarizeRoute,
  type PressRecord,
} from "./metrics";

const gold = (over: Partial<Gold> = {}): Gold => ({
  askTo: "you",
  heard: ["clear", "partial"],
  say: "expected",
  sayLang: "en",
  names: [],
  numbers: [],
  dates: [],
  terms: [],
  ...over,
});

const body = (over: Partial<CardBody> = {}): CardBody => ({
  heard: "clear",
  ask: { to: "you", text: "Does Thursday work for the demo?" },
  say: { text: "Just to check, Thursday for the demo?", lang: "en" },
  summary: ["Marcus asked if Thursday works for the demo."],
  facts: [],
  ...over,
});

const wire = (over: Partial<CardBody> = {}, meta: Partial<ServerCardMeta> = {}): WireCard => ({
  ...body(over),
  meta: {
    route: "open_weights",
    model: "meta-models/muse-spark-open-1026",
    parse: "clean",
    timing: { totalMs: 3000, bytes: 864_044 },
    ...meta,
  },
});

const clip = (id: string, g: Gold, scene = `Scene ${id}`): EvalClip => ({
  id,
  use: "eval",
  scene,
  source: "tab",
  meetingLang: "en",
  cardLang: "en",
  spokenLangs: ["en"],
  listener: ["Maya"],
  durationSec: 25,
  effect: "call",
  noise: { kind: "room", snrDb: 35 },
  lines: [{ speaker: "A", voice: "en-m", lang: "en", text: "Hello there." }],
  gold: g,
});

const record = (clipId: string, run: number, card: WireCard | null, over: Partial<PressRecord> = {}): PressRecord => ({
  clipId,
  route: "open_weights",
  run,
  cardLang: "en",
  sentSec: 25,
  bytes: 800_044,
  httpStatus: 200,
  stages: [],
  firstTokenMs: card ? 1000 * run : null,
  cardMs: card ? 3000 * run : null,
  totalMs: 3100 * run,
  card,
  error: card ? null : { code: "provider_error", retryable: true, stored: false },
  failure: null,
  invalidEvents: 0,
  ...over,
});

describe("text helpers", () => {
  it("folds case, width, accents, spacing and kana for name matching", () => {
    expect(normalizeForMatch("Joaquín")).toBe("joaquin");
    expect(normalizeForMatch("ワン・レイ")).toBe("わんれい");
    expect(normalizeForMatch("Ｓｉｏｂｈａｎ (TA)")).toBe("siobhanta");
    expect(normalizeForMatch("陈老师")).toBe("陈老师");
    expect(normalizeForMatch("がっこう")).toBe("がっこう");
  });

  it("reads Chinese and Japanese numerals", () => {
    expect(parseCjkNumeral("三千六百")).toBe(3600);
    expect(parseCjkNumeral("十五")).toBe(15);
    expect(parseCjkNumeral("十")).toBe(10);
    expect(parseCjkNumeral("百二十")).toBe(120);
    expect(parseCjkNumeral("四万二千")).toBe(42000);
    expect(parseCjkNumeral("二〇二六")).toBe(2026);
    expect(parseCjkNumeral("4.2万")).toBe(42000);
    expect(parseCjkNumeral("3千6百")).toBe(3600);
    expect(parseCjkNumeral("1万2千")).toBe(12000);
    expect(parseCjkNumeral("")).toBeNull();
  });

  it("reads English number words", () => {
    expect(englishNumberWords("forty-two thousand dollars")).toEqual([42000]);
    expect(englishNumberWords("three hundred and twelve responses")).toEqual([312]);
    expect(englishNumberWords("fifteen percent, due the thirteenth")).toEqual([15, 13]);
    expect(englishNumberWords("anyone with two thousand words")).toEqual([2000]);
  });

  it("finds numbers in every script the card may use", () => {
    expect(extractNumbers("15%")).toEqual([15]);
    expect(extractNumbers("3,600円")).toEqual([3600]);
    expect(extractNumbers("三千六百円")).toEqual([3600]);
    expect(extractNumbers("３６００円")).toEqual([3600]);
    expect(extractNumbers("$42,000 budget")).toEqual([42000]);
    expect(extractNumbers("42k")).toEqual([42000]);
    expect(extractNumbers("4.2万ドル")).toEqual([42000]);
    expect(extractNumbers("百分之十五")).toEqual([15]);
    expect(extractNumbers("Ch. 13 to 16")).toEqual([13, 16]);
    expect(extractNumbers("the 13th")).toEqual([13]);
    expect(extractNumbers("three hundred and twelve")).toEqual([312]);
    expect(extractNumbers("Rosa")).toEqual([]);
  });

  it("finds resolved dates and skips unresolved ones", () => {
    expect(extractDates("Wed Nov 11, 3 pm")).toEqual([{ month: 11, day: 11 }]);
    expect(extractDates("November 13th, 2026")).toEqual([{ month: 11, day: 13, year: 2026 }]);
    expect(extractDates("13 Nov")).toEqual([{ month: 11, day: 13 }]);
    expect(extractDates("11月11日(水)")).toEqual([{ month: 11, day: 11 }]);
    expect(extractDates("11月11号")).toEqual([{ month: 11, day: 11 }]);
    expect(extractDates("十一月十一日")).toEqual([{ month: 11, day: 11 }]);
    expect(extractDates("2026年11月20日")).toEqual([{ month: 11, day: 20, year: 2026 }]);
    expect(extractDates("2026-11-05")).toEqual([{ month: 11, day: 5, year: 2026 }]);
    expect(extractDates("11/9")).toEqual([{ month: 11, day: 9 }]);
    expect(extractDates("the thirteenth")).toEqual([]);
    expect(extractDates("Thursday")).toEqual([]);
    expect(extractDates("下周三")).toEqual([]);
  });

  it("finds clock times, with both readings when am or pm is missing", () => {
    expect(extractTimes("3:30 pm")).toEqual([930]);
    expect(extractTimes("15:30")).toEqual([930]);
    expect(extractTimes("3:30")).toEqual([210, 930]);
    expect(extractTimes("9 pm tonight")).toEqual([1260]);
    expect(extractTimes("下午三点半")).toEqual([930]);
    expect(extractTimes("下午3点")).toEqual([900]);
    expect(extractTimes("午後3時半")).toEqual([930]);
    expect(extractTimes("15時30分")).toEqual([930]);
    expect(extractTimes("noon")).toEqual([720]);
    expect(extractTimes("Room 312")).toEqual([]);
  });

  it("pairs teen and tens numbers", () => {
    expect(confusablePair(15)).toBe(50);
    expect(confusablePair(50)).toBe(15);
    expect(confusablePair(13)).toBe(30);
    expect(confusablePair(90)).toBe(19);
    expect(confusablePair(20)).toBeNull();
    expect(confusablePair(100)).toBeNull();
  });

  it("tells the script a line is written in", () => {
    expect(scriptLangOf("Marcus asked if Thursday works.")).toBe("en");
    expect(scriptLangOf("木曜日でいいか聞かれました。")).toBe("ja");
    expect(scriptLangOf("有人问周四是否可以。")).toBe("zh");
    expect(scriptLangOf("有人问谁能写October survey的总结")).toBe("zh");
    expect(scriptLangOf("123")).toBe("unknown");
  });

  it("takes nearest-rank percentiles", () => {
    const ten = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 95)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("scoreCard", () => {
  const askByName = gold({
    names: [{ text: "Tomas", alts: ["Thomas"] }, { text: "Nordvale", alts: [] }],
    dates: [
      { date: "2026-11-05", said: "Thursday" },
      { date: "2026-11-09", said: "Monday" },
    ],
  });

  it("scores ask, names and dates from the facts", () => {
    const s = scoreCard(
      body({
        facts: [
          { kind: "date", text: "Thu Nov 5" },
          { kind: "date", text: "Mon Nov 9", note: "if the demo moves" },
          { kind: "name", text: "Thomas", unsure: true, note: "or Tomas" },
        ],
      }),
      askByName,
      "en",
    );
    expect(s.askCorrect).toBe(true);
    expect(s.falseAlarm).toBe(false);
    expect(s.miss).toBe(false);
    expect(s.names).toEqual({ hit: 1, total: 2, missed: ["Nordvale"] });
    expect(s.dates).toEqual({ hit: 2, total: 2, missed: [] });
    expect(s.heardOk).toBe(true);
    expect(s.sayOk).toBe(true);
    expect(s.sayLangOk).toBe(true);
    expect(s.cardLangOk).toBe(true);
  });

  it("counts Asked you on a room question as a false alarm, and the reverse as a miss", () => {
    expect(scoreCard(body(), gold({ askTo: "room" }), "en")).toMatchObject({ askCorrect: false, falseAlarm: true, miss: false });
    expect(scoreCard(body({ ask: { to: "room", text: "Who can write it?" } }), gold(), "en")).toMatchObject({
      askCorrect: false,
      falseAlarm: false,
      miss: true,
    });
  });

  it("credits a number found in a note, and checks the unsure mark on teen numbers", () => {
    const g = gold({ numbers: [{ value: 15, said: "fifteen percent", confusable: true }] });
    const flagged = scoreCard(body({ facts: [{ kind: "number", text: "50%", note: "or 15%?", unsure: true }] }), g, "en");
    expect(flagged.numbers.hit).toBe(1);
    expect(flagged.confusable).toEqual({ flagged: 1, found: 1 });
    const unflagged = scoreCard(body({ facts: [{ kind: "number", text: "15%" }] }), g, "en");
    expect(unflagged.confusable).toEqual({ flagged: 0, found: 1 });
  });

  it("does not count a date's day as a number", () => {
    const g = gold({ numbers: [{ value: 13, said: "thirteen" }] });
    expect(scoreCard(body({ facts: [{ kind: "date", text: "Fri Nov 13" }] }), g, "en").numbers.hit).toBe(0);
  });

  it("needs the time when the script names one", () => {
    const g = gold({ dates: [{ date: "2026-11-03", time: "15:30", said: "明天下午三点半" }] });
    expect(scoreCard(body({ facts: [{ kind: "date", text: "11月3日(火) 15:30" }] }), g, "ja").dates.hit).toBe(1);
    expect(scoreCard(body({ facts: [{ kind: "date", text: "11月3日(火)" }] }), g, "ja").dates.hit).toBe(0);
    expect(scoreCard(body({ facts: [{ kind: "date", text: "明天下午三点半" }] }), g, "ja").dates.hit).toBe(0);
    expect(
      scoreCard(body({ facts: [{ kind: "date", text: "11月3日(火)" }, { kind: "term", text: "会議 午後3時半" }] }), g, "ja").dates.hit,
    ).toBe(1);
  });

  it("matches names across scripts and spellings", () => {
    const g = gold({ names: [{ text: "王磊", alts: ["Wang Lei"] }, { text: "Siobhan", alts: ["シボーン"] }] });
    const s = scoreCard(
      body({ facts: [{ kind: "name", text: "Wang Lei" }, { kind: "name", text: "Shivon", note: "シボーン？" }] }),
      g,
      "en",
    );
    expect(s.names.hit).toBe(2);
  });

  it("checks the say line, heard and the card language", () => {
    const silent = gold({ askTo: "none", heard: ["none"], say: "absent" });
    const noSpeech = body({ heard: "none", ask: { to: "none" }, say: undefined, summary: ["No speech."] });
    expect(scoreCard(noSpeech, silent, "en")).toMatchObject({ heardOk: true, sayOk: true, sayLangOk: null });
    expect(scoreCard(body(), silent, "en")).toMatchObject({ heardOk: false, sayOk: false });
    expect(scoreCard(body({ summary: ["木曜日でいいか聞かれました。"] }), gold(), "ja").cardLangOk).toBe(true);
    expect(scoreCard(body(), gold(), "zh").cardLangOk).toBe(false);
    expect(scoreCard(body({ say: { text: "确认一下，周四？", lang: "zh" } }), gold(), "en").sayLangOk).toBe(false);
  });
});

describe("summarizeRoute", () => {
  const clips = [
    clip("a-you", gold({ dates: [{ date: "2026-11-05", said: "Thursday" }] })),
    clip("b-room", gold({ askTo: "room", names: [{ text: "Priya", alts: [] }] })),
    clip("c-none", gold({ askTo: "none" })),
  ];
  const youCard = wire({ facts: [{ kind: "date", text: "Thu Nov 5" }] });
  const records: PressRecord[] = [
    record("a-you", 1, youCard),
    record("a-you", 2, wire({}, { fallbackFrom: "open_weights", fallbackCause: "timeout", route: "meta_api", model: "muse-voice-transcribe-1.0 + muse-spark-1.3" })),
    record("b-room", 1, wire({ facts: [{ kind: "name", text: "Priya" }] })),
    record("b-room", 2, wire({ ask: { to: "room", text: "Who can write it?" }, facts: [] }, { parse: "clamped" })),
    record("c-none", 1, wire({ ask: { to: "none" } }, { parse: "unformatted", unformatted: true })),
    record("c-none", 2, null),
    record("gone", 1, youCard),
  ];
  const s = summarizeRoute("open_weights", records, clips);

  it("counts presses, cards, errors and unknown clips", () => {
    expect(s.presses).toBe(6);
    expect(s.cards).toBe(5);
    expect(s.errors).toBe(1);
    expect(s.errorCodes).toEqual({ provider_error: 1 });
    expect(s.unknownClips).toBe(1);
    expect(s.models).toEqual(["meta-models/muse-spark-open-1026", "muse-voice-transcribe-1.0 + muse-spark-1.3"]);
  });

  it("scores asks, false alarms and recall over cards", () => {
    expect(s.askState).toEqual({ num: 4, den: 5 });
    expect(s.askedYou).toEqual({ num: 4, den: 5 });
    expect(s.falseAlarms).toEqual({ num: 1, den: 3 });
    expect(s.misses).toEqual({ num: 0, den: 2 });
    expect(s.dateRecall).toEqual({ num: 1, den: 2 });
    expect(s.nameRecall).toEqual({ num: 1, den: 2 });
  });

  it("reads JSON validity and fallbacks from meta", () => {
    expect(s.validJsonFirstTry).toEqual({ num: 3, den: 5 });
    expect(s.cleanJson).toEqual({ num: 2, den: 5 });
    expect(s.unformatted).toEqual({ num: 1, den: 5 });
    expect(s.fallbacks).toEqual({ num: 1, den: 5 });
  });

  it("takes latency percentiles over cards only", () => {
    expect(s.fullCard).toEqual({ p50: 3000, p95: 6000, n: 5 });
    expect(s.firstToken).toEqual({ p50: 1000, p95: 2000, n: 5 });
  });

  it("keeps a row per clip with every run's ask", () => {
    expect(s.clips.map((c) => [c.clipId, c.predicted])).toEqual([
      ["a-you", ["you", "you"]],
      ["b-room", ["you", "room"]],
      ["c-none", ["none", "error"]],
    ]);
  });
});

describe("renderSummaryMarkdown", () => {
  const clips = [clip("a-you", gold()), clip("b-room", gold({ askTo: "room" }), "Open question to the room in an online meeting")];
  const live = summarizeRoute("open_weights", [record("a-you", 1, wire()), record("b-room", 1, wire()), record("b-room", 2, null)], clips);
  const auto = summarizeRoute("auto", [record("a-you", 1, wire({}, { route: "meta_api", fallbackFrom: "open_weights" }), { route: "auto" })], clips);
  const mock = summarizeRoute("mock", [record("a-you", 1, wire({}, { route: "mock", model: "mock" }), { route: "mock" })], clips);
  const md = renderSummaryMarkdown({
    generatedAt: "2026-11-03T20:00:00.000Z",
    audio: "synthetic Windows voices reading the scripts in `eval/clips.json`",
    runsPerRoute: 3,
    pressTime: "Mon Nov 2 2026 at 10:30 in `America/New_York`, unless a clip sets its own",
    realClockRoutes: ["auto"],
    sources: ["eval/results/raw/2026-11-03T20-00-00-000Z-open_weights.json"],
    routes: [live, auto, mock],
  });

  it("says which routes ran on the real clock", () => {
    expect(md).toContain("Runs of `auto` used the real clock as the press time instead, so their date recall can differ.");
  });

  it("follows the writing rules on every line", () => {
    const separator = /^\|(\s*---\s*\|)+$/;
    const problems = md
      .split("\n")
      .filter((line) => !separator.test(line))
      .flatMap((line) => copyRuleProblems(line).map((p) => `${p} in ${line}`));
    expect(problems).toEqual([]);
  });

  it("puts live routes in the main table and mock in its own section", () => {
    const main = md.slice(md.indexOf("## Live routes"), md.indexOf("## Quality checks"));
    expect(main).toContain("Muse Spark Open on Baseten (`open_weights`)");
    expect(main).toContain("`meta-models/muse-spark-open-1026`");
    expect(main).not.toContain("(`mock`)");
    expect(md).toContain("## Mock smoke run");
    expect(md).toContain("No model was called.");
    expect(md).toContain("| `b-room` | Open question to the room in an online meeting | room |");
    expect(md).toContain("`open_weights` had 1 failed presses (provider_error 1).");
  });

  it("formats rates and empty data in words", () => {
    expect(formatRate({ num: 0, den: 0 })).toBe("no data");
    expect(formatRate({ num: 28, den: 30 })).toBe("93% (28 of 30)");
  });

  it("says so when no live route has run", () => {
    const onlyMock = renderSummaryMarkdown({
      generatedAt: "2026-11-03T20:00:00.000Z",
      audio: "synthetic voices",
      runsPerRoute: 1,
      pressTime: "Mon Nov 2 2026 at 10:30",
      sources: [],
      routes: [mock],
    });
    expect(onlyMock).toContain("No live route has run yet.");
    expect(onlyMock).toContain("every clip ran 1 time per route");
  });
});
