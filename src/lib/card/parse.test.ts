import { describe, expect, it } from "vitest";
import { fieldsOverCap } from "./caps";
import {
  applyNumberBackstop,
  clampCardBody,
  extractJsonObject,
  parseCardText,
  readsAsEnglish,
  stripModelText,
  teenTensPair,
  unformattedBody,
  type ClampContext,
} from "./parse";
import { CardBody, UNFORMATTED_MAX_CHARS, type Fact } from "./schema";
import { localString, repeatLine } from "./strings";

const EN: ClampContext = { cardLang: "en", meetingLang: "en" };
const JA_EN: ClampContext = { cardLang: "ja", meetingLang: "en" };
const ZH: ClampContext = { cardLang: "zh", meetingLang: "zh" };

const enCard: CardBody = {
  heard: "clear",
  ask: { to: "you", text: "Can you send the slides by Friday?", by: "Dana" },
  say: { text: "Just to check, the slides by this Friday?", lang: "en" },
  summary: ["Dana asked you to send the slides by Friday.", "The client call is next week."],
  facts: [
    { kind: "name", text: "Dana" },
    { kind: "date", text: "Fri Nov 6", note: "this Friday" },
  ],
  quote: "Mina, can you send the slides by Friday?",
};

const jaCard: CardBody = {
  heard: "partial",
  ask: { to: "you", text: "デモは木曜でいいか、月曜に延ばすか", by: "Alex" },
  say: {
    text: "Just to check, Thursday for the demo, or push to Monday?",
    lang: "en",
    gloss: "確認です。デモは木曜ですか、月曜に延ばしますか。",
  },
  summary: ["デモの日程を聞かれた", "木曜か月曜かを決める流れ"],
  facts: [{ kind: "date", text: "11月5日（木）", note: "今週の木曜日" }],
  quote: "Seika, are we good for Thursday, or should we push the demo to Monday?",
};

const zhCard: CardBody = {
  heard: "clear",
  ask: { to: "room", text: "周四的策划会谁能做会议记录？", by: "周经理" },
  say: { text: "确认一下，是周四策划会的会议记录吧？", lang: "zh" },
  summary: ["周经理在问大家周四谁能做会议记录。"],
  facts: [{ kind: "task", text: "策划会做会议记录" }],
  quote: "好，周四的策划会谁能做一下会议记录？",
};

const json = (value: unknown) => JSON.stringify(value);

function expectClamped(input: unknown, ctx: ClampContext = EN) {
  const out = clampCardBody(input, ctx);
  expect(out).not.toBeNull();
  if (!out) throw new Error("unreachable");
  expect(CardBody.safeParse(out.body).success).toBe(true);
  expect(fieldsOverCap(out.body)).toEqual([]);
  return out;
}

describe("stripModelText", () => {
  it("removes code fences and trims", () => {
    expect(stripModelText('```json\n{"a":1}\n```\n')).toBe('{"a":1}');
    expect(stripModelText('  ```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripModelText('```JSON{"a":1}```')).toBe('{"a":1}');
  });

  it("removes control tokens and keeps only the part addressed to the user", () => {
    const leaked =
      '<|start|>assistant to=self<|message|>Thinking about {braces} first<|end|><|start|>assistant to=user<|message|>{"a":1}<|end|>';
    expect(stripModelText(leaked)).toBe('{"a":1}');
    expect(stripModelText('<|channel|>analysis<|message|>hmm {x}<|end|><|channel|>final<|message|>{"b":2}')).toBe(
      '{"b":2}',
    );
    expect(stripModelText('to=commentary\n{"c":3}<|return|>')).toBe('{"c":3}');
    expect(stripModelText('<think>{"no":1}</think>{"yes":1}')).toBe('{"yes":1}');
  });
});

describe("extractJsonObject", () => {
  it("takes the outermost braces", () => {
    expect(extractJsonObject('Here is the card {"a":{"b":1}} done')).toBe('{"a":{"b":1}}');
    expect(extractJsonObject("no braces here")).toBeNull();
    expect(extractJsonObject("} backwards {")).toBeNull();
  });
});

describe("parseCardText", () => {
  it("accepts clean English, Japanese and Chinese cards unchanged", () => {
    expect(parseCardText(json(enCard), EN)).toEqual({ ok: true, body: enCard, quality: "clean" });
    expect(parseCardText(json(jaCard), JA_EN)).toEqual({ ok: true, body: jaCard, quality: "clean" });
    expect(parseCardText(json(zhCard), ZH)).toEqual({ ok: true, body: zhCard, quality: "clean" });
  });

  it("reads fenced JSON with prose around it", () => {
    const raw = `Sure, here is the card.\n\`\`\`json\n${JSON.stringify(enCard, null, 2)}\n\`\`\`\nLet me know!`;
    expect(parseCardText(raw, EN)).toEqual({ ok: true, body: enCard, quality: "clean" });
  });

  it("reads a card behind leaked control tokens", () => {
    const raw = `<|start|>assistant to=user<|message|>${json(zhCard)}<|end|>`;
    expect(parseCardText(raw, ZH)).toEqual({ ok: true, body: zhCard, quality: "clean" });
  });

  it("reports why nothing could be read", () => {
    expect(parseCardText("", EN)).toEqual({ ok: false, reason: "empty" });
    expect(parseCardText("  ```json\n```  ", EN)).toEqual({ ok: false, reason: "empty" });
    expect(parseCardText("I could not hear anything.", EN)).toEqual({ ok: false, reason: "no_json" });
    expect(parseCardText('{"heard": "clear", "ask": {"to": "you", "text": "Fri', EN)).toEqual({
      ok: false,
      reason: "bad_json",
    });
    expect(parseCardText('{"heard": "clear", "summary": ["a" "b"]}', EN)).toEqual({ ok: false, reason: "bad_json" });
    expect(parseCardText('{"foo": 1}', EN)).toEqual({ ok: false, reason: "not_card" });
    expect(parseCardText("[1, 2, {}]", EN)).toEqual({ ok: false, reason: "not_card" });
  });

  it("repairs trailing commas and marks the card clamped", () => {
    const raw = '{"heard":"clear","ask":{"to":"none",},"summary":["The demo moved to Monday.",],"facts":[],}';
    const out = parseCardText(raw, EN);
    expect(out).toMatchObject({ ok: true, quality: "clamped" });
    if (out.ok) expect(out.body.summary).toEqual(["The demo moved to Monday."]);
  });

  it("finds the card among other braces", () => {
    const raw = `Notes {draft} first. ${json(enCard)} and {"other": true}`;
    const out = parseCardText(raw, EN);
    expect(out).toMatchObject({ ok: true, body: enCard });
  });

  it("unwraps a card nested under one key", () => {
    const out = parseCardText(json({ card: enCard }), EN);
    expect(out).toEqual({ ok: true, body: enCard, quality: "clamped" });
  });

  it("applies the teen and tens backstop", () => {
    const raw = json({
      ...enCard,
      facts: [{ kind: "number", text: "15%" }],
    });
    const out = parseCardText(raw, EN);
    expect(out.ok && out.body.facts[0]).toEqual({ kind: "number", text: "15%", note: "or 50%", unsure: true });
  });
});

describe("clampCardBody", () => {
  it("returns null only when no summary text exists", () => {
    expect(clampCardBody(null, EN)).toBeNull();
    expect(clampCardBody("card", EN)).toBeNull();
    expect(clampCardBody([enCard], EN)).toBeNull();
    expect(clampCardBody({}, EN)).toBeNull();
    expect(clampCardBody({ heard: "clear", ask: { to: "none" }, summary: [], facts: [] }, EN)).toBeNull();
  });

  it("never throws on junk", () => {
    const junk: unknown[] = [
      undefined,
      0,
      true,
      [],
      { heard: 5, ask: [], say: 7, summary: { a: 1 }, facts: "x", quote: {}, earlier: "maybe" },
      { heard: null, ask: { to: null, text: 12, by: [] }, summary: [null, 3, "ok"], facts: [null, 1, "two", {}] },
      { summary: ["x".repeat(10_000)], facts: Array.from({ length: 50 }, (_, i) => ({ kind: "number", text: i })) },
      { summary: "Only a string summary.", say: { text: "", lang: "xx" }, ask: "Everyone" },
    ];
    for (const input of junk) {
      expect(() => clampCardBody(input, EN)).not.toThrow();
      const out = clampCardBody(input, EN);
      if (out) {
        expect(CardBody.safeParse(out.body).success).toBe(true);
        expect(fieldsOverCap(out.body)).toEqual([]);
        expect(out.quality).toBe("clamped");
      }
    }
  });

  it("coerces near-miss enums and drops unknown ones to safe values", () => {
    const out = expectClamped({
      heard: "Loud",
      ask: { to: "Seika", text: "Can you share the deck?" },
      say: { text: "Just to check, share the deck now?", lang: "English" },
      summary: ["Someone asked about the deck."],
      facts: [
        { kind: "Person", text: "Dana" },
        { kind: "gizmo", text: "deck" },
        { kind: "Action Item", text: "Share the deck" },
      ],
    });
    expect(out.quality).toBe("clamped");
    expect(out.body.heard).toBe("partial");
    expect(out.body.ask).toEqual({ to: "none" });
    expect(out.body.say?.lang).toBe("en");
    expect(out.body.facts.map((f) => f.kind)).toEqual(["name", "term", "task"]);

    expect(expectClamped({ heard: "No Speech", ask: { to: "none" }, summary: ["Silence."], facts: [] }).body.heard).toBe(
      "none",
    );
    expect(
      expectClamped({ heard: "CLEAR", ask: { to: "Everyone", text: "Who has notes?" }, summary: ["x"], facts: [] }).body
        .ask.to,
    ).toBe("room");
  });

  it("infers a missing say language from its script", () => {
    const base = { heard: "clear", ask: { to: "none" }, summary: ["x"], facts: [] };
    expect(expectClamped({ ...base, say: { text: "つまり金曜ですね？" } }).body.say?.lang).toBe("ja");
    expect(expectClamped({ ...base, say: { text: "所以是周五，对吧？" } }).body.say?.lang).toBe("zh");
    expect(expectClamped({ ...base, say: "So it is Friday, right?" }).body.say).toEqual({
      text: "So it is Friday, right?",
      lang: "en",
    });
    expect(expectClamped({ ...base, say: { text: "¿Entonces el viernes?" } }).body.say?.lang).toBe("other");
  });

  it("clips every over-long field to its cap at a boundary", () => {
    const longEn = "This sentence keeps going with more and more words so that it is far too long for any cap. ".repeat(3);
    const longJa = "来週の水曜日の午後三時から会議室で全体の進捗を確認する予定になっています。".repeat(3);
    const longZh = "下周三下午三点在会议室确认整体进度，请大家提前准备好材料。".repeat(3);
    for (const [text, ctx] of [
      [longEn, EN],
      [longJa, JA_EN],
      [longZh, ZH],
    ] as const) {
      const out = expectClamped(
        {
          heard: "clear",
          ask: { to: "you", text, by: text },
          say: { text, lang: "other", gloss: text },
          summary: [text, text],
          facts: [{ kind: "term", text, note: text }],
          quote: text,
        },
        ctx,
      );
      expect(out.quality).toBe("clamped");
      expect(out.body.summary[0].endsWith("…")).toBe(true);
      expect(out.body.facts[0].text.endsWith("…")).toBe(true);
      expect(out.body.quote?.endsWith("…")).toBe(true);
    }
  });

  it("splits one long summary string at its first sentence", () => {
    const out = expectClamped({
      heard: "clear",
      ask: { to: "none" },
      summary: "The team agreed to move the launch to next Friday after a long talk. Lee will update the timeline and tell the client.",
      facts: [],
    });
    expect(out.body.summary).toEqual([
      "The team agreed to move the launch to next Friday after a long talk.",
      "Lee will update the timeline and tell the client.",
    ]);
  });

  it("keeps at most 2 summary lines and 5 facts, and drops invalid facts", () => {
    const out = expectClamped({
      heard: "clear",
      ask: { to: "none" },
      summary: ["one", "two", "three"],
      facts: [
        { kind: "name", text: "A" },
        { kind: "name" },
        { kind: "name", text: "   " },
        "B as a plain string",
        { kind: "name", text: "C", unsure: "true" },
        { kind: "name", text: "D", unsure: false },
        { kind: "name", text: "E" },
        { kind: "name", text: "F" },
        { kind: "name", text: "G" },
      ],
    });
    expect(out.body.summary).toEqual(["one", "two"]);
    expect(out.body.facts).toEqual([
      { kind: "name", text: "A" },
      { kind: "term", text: "B as a plain string" },
      { kind: "name", text: "C", unsure: true },
      { kind: "name", text: "D" },
      { kind: "name", text: "E" },
    ]);
  });

  it("treats null, false and empty optional fields as absent without clamping", () => {
    const out = expectClamped({
      heard: "clear",
      ask: { to: "none", text: null, by: "" },
      say: null,
      summary: ["The demo moved to Monday."],
      facts: [{ kind: "date", text: "Mon Nov 9", note: null, unsure: false }],
      quote: "",
      earlier: false,
      extra: "ignored",
    });
    expect(out.quality).toBe("clean");
    expect(out.body).toEqual({
      heard: "clear",
      ask: { to: "none" },
      summary: ["The demo moved to Monday."],
      facts: [{ kind: "date", text: "Mon Nov 9" }],
    });
  });

  it("enforces the ask rules", () => {
    const fromQuote = expectClamped({
      heard: "clear",
      ask: { to: "you" },
      summary: ["x"],
      facts: [],
      quote: "Mina, can you take notes?",
    });
    expect(fromQuote.body.ask).toEqual({ to: "you", text: "Mina, can you take notes?" });

    const noQuote = expectClamped({ heard: "clear", ask: { to: "room", by: "Dana" }, summary: ["x"], facts: [] });
    expect(noQuote.body.ask).toEqual({ to: "none" });

    const noneWithText = expectClamped({
      heard: "clear",
      ask: { to: "none", text: "Nothing was asked.", by: "Dana" },
      summary: ["x"],
      facts: [],
    });
    expect(noneWithText.body.ask).toEqual({ to: "none" });
    expect(noneWithText.quality).toBe("clamped");
  });

  it("applies heard none", () => {
    const out = expectClamped({
      heard: "none",
      ask: { to: "you", text: "Can you hear me?" },
      say: { text: "Sorry?", lang: "en" },
      summary: ["Only music played. Then silence.", "More context."],
      facts: [{ kind: "term", text: "music" }],
    });
    expect(out.body).toEqual({ heard: "none", ask: { to: "none" }, summary: ["Only music played."], facts: [] });
    expect(out.quality).toBe("clamped");

    const bare = expectClamped({ heard: "none" }, JA_EN);
    expect(bare.body.summary).toEqual([localString("ja", "noSpeech")]);
  });

  it("fills the repeat line when heard is poor and say is missing", () => {
    const poor = { heard: "poor", ask: { to: "none" }, summary: ["Hard to follow."], facts: [] };
    expect(expectClamped(poor, JA_EN).body.say).toEqual({ text: repeatLine("en"), lang: "en", gloss: repeatLine("ja") });
    expect(expectClamped(poor, EN).body.say).toEqual({ text: repeatLine("en"), lang: "en" });
    expect(expectClamped(poor, { cardLang: "en", meetingLang: "zh" }).body.say).toEqual({
      text: repeatLine("zh"),
      lang: "zh",
      gloss: repeatLine("en"),
    });
    const kept = expectClamped({ ...poor, say: { text: "Sorry, which day?", lang: "en" } }, EN);
    expect(kept.body.say).toEqual({ text: "Sorry, which day?", lang: "en" });
    expect(kept.quality).toBe("clean");
  });

  it("drops the gloss when the say line is already in the card language", () => {
    const out = expectClamped(
      {
        heard: "clear",
        ask: { to: "none" },
        say: { text: "つまり金曜ですね？", lang: "ja", gloss: "つまり金曜ですね？" },
        summary: ["金曜に決まりました。"],
        facts: [],
      },
      JA_EN,
    );
    expect(out.body.say).toEqual({ text: "つまり金曜ですね？", lang: "ja" });
    expect(out.quality).toBe("clamped");
  });

  it("falls back to ask text or the quote when summary is missing", () => {
    const fromAsk = expectClamped({ heard: "clear", ask: { to: "you", text: "Can you take notes?" }, facts: [] });
    expect(fromAsk.body.summary).toEqual(["Can you take notes?"]);
    const fromQuote = expectClamped({ heard: "clear", ask: { to: "none" }, quote: "We start at nine." });
    expect(fromQuote.body.summary).toEqual(["We start at nine."]);
  });

  it("collapses whitespace and removes control characters", () => {
    const out = expectClamped({
      heard: "clear",
      ask: { to: "none" },
      summary: ["  The demo\n moved\u0000 to\tMonday.  "],
      facts: [],
      quote: "We‮ moved it.",
    });
    expect(out.body.summary).toEqual(["The demo moved to Monday."]);
    expect(out.body.quote).toBe("We moved it.");
  });
});

describe("applyNumberBackstop", () => {
  const withFacts = (facts: Fact[], patch: Partial<CardBody> = {}): CardBody => ({
    ...enCard,
    facts,
    ...patch,
  });

  it("pairs teens and round tens", () => {
    expect(teenTensPair(13)).toBe(30);
    expect(teenTensPair(15)).toBe(50);
    expect(teenTensPair(19)).toBe(90);
    expect(teenTensPair(30)).toBe(13);
    expect(teenTensPair(50)).toBe(15);
    expect(teenTensPair(90)).toBe(19);
    expect(teenTensPair(20)).toBeNull();
    expect(teenTensPair(35)).toBeNull();
    expect(teenTensPair(12)).toBeNull();
  });

  it("flags 15 and 50, 13 and 30 when the talk is English", () => {
    const out = applyNumberBackstop(
      withFacts([
        { kind: "number", text: "15%" },
        { kind: "number", text: "about 30 people" },
        { kind: "number", text: "$50" },
        { kind: "date", text: "Nov 13" },
      ]),
    );
    expect(out.facts).toEqual([
      { kind: "number", text: "15%", note: "or 50%", unsure: true },
      { kind: "number", text: "about 30 people", note: "or about 13 people", unsure: true },
      { kind: "number", text: "$50", note: "or $15", unsure: true },
      { kind: "date", text: "Nov 13" },
    ]);
  });

  it("leaves numbers outside the pairs alone", () => {
    const facts: Fact[] = [
      { kind: "number", text: "20" },
      { kind: "number", text: "1,500" },
      { kind: "number", text: "15.5%" },
      { kind: "number", text: "150" },
      { kind: "number", text: "15:30" },
    ];
    const body = withFacts(facts);
    expect(applyNumberBackstop(body)).toBe(body);
  });

  it("keeps what the model already did", () => {
    const done = withFacts([{ kind: "number", text: "15%", note: "or 50%", unsure: true }]);
    expect(applyNumberBackstop(done)).toBe(done);
    const words = withFacts([{ kind: "number", text: "15%", note: "maybe fifty" }]);
    expect(applyNumberBackstop(words).facts[0]).toEqual({ kind: "number", text: "15%", note: "maybe fifty", unsure: true });
    const both = withFacts([{ kind: "number", text: "15 or 50 people", unsure: true }]);
    expect(applyNumberBackstop(both)).toBe(both);
  });

  it("adds the pair to an existing note", () => {
    const out = applyNumberBackstop(withFacts([{ kind: "number", text: "15%", note: "of the travel budget" }]));
    expect(out.facts[0]).toEqual({ kind: "number", text: "15%", note: "of the travel budget (or 50%)", unsure: true });
    const long = applyNumberBackstop(
      withFacts([{ kind: "number", text: "15%", note: "of the whole travel and equipment budget" }]),
    );
    expect(long.facts[0].note?.endsWith("(or 50%)")).toBe(true);
    expect(fieldsOverCap(long)).toEqual([]);
  });

  it("writes the pair note in the card language", () => {
    const ja = applyNumberBackstop({ ...jaCard, facts: [{ kind: "number", text: "15%" }] });
    expect(ja.facts[0]).toEqual({ kind: "number", text: "15%", note: "または50%", unsure: true });
    const enWithKana = applyNumberBackstop({
      ...enCard,
      summary: ["Sakura (佐倉さん) asked every team to cut its budget before the review."],
      facts: [{ kind: "number", text: "15%" }],
    });
    expect(enWithKana.facts[0].note).toBe("or 50%");
    const parsed = parseCardText(json({ ...jaCard, facts: [{ kind: "number", text: "30人" }] }), JA_EN);
    expect(parsed.ok && parsed.body.facts[0]).toEqual({ kind: "number", text: "30人", note: "または13人", unsure: true });
    const zh = applyNumberBackstop({
      ...zhCard,
      say: { text: "Just to check, 15 people?", lang: "en", gloss: "确认一下，是15个人吗？" },
      facts: [{ kind: "number", text: "15人" }],
    });
    expect(zh.facts[0]).toEqual({ kind: "number", text: "15人", note: "也可能是50人", unsure: true });
  });

  it("runs on an English quote when say is left out, and never on Japanese or Chinese talk", () => {
    const quoteOnly: CardBody = {
      heard: "clear",
      ask: { to: "none" },
      summary: ["A lecture about budgets."],
      facts: [{ kind: "number", text: "40" }],
      quote: "We cut the budget by forty percent last year.",
    };
    expect(applyNumberBackstop(quoteOnly).facts[0]).toEqual({ kind: "number", text: "40", note: "or 14", unsure: true });
    const japanese = { ...zhCard, facts: [{ kind: "number" as const, text: "15人" }] };
    expect(applyNumberBackstop(japanese)).toBe(japanese);
  });

  it("tells English from other scripts", () => {
    expect(readsAsEnglish("Can everyone trim their budget by fifteen percent?")).toBe(true);
    expect(readsAsEnglish("Mina, could you review the PR before tomorrow's demo? 明日の10時からね。")).toBe(true);
    expect(readsAsEnglish("ミナさん、明日のdemoの前にPRをreviewしてもらえますか？")).toBe(false);
    expect(readsAsEnglish("¿Podemos cambiar la reunión al viernes?")).toBe(false);
  });
});

describe("unformattedBody", () => {
  it("puts the cleaned raw text in a plain card", () => {
    const body = unformattedBody("<|start|>```\nThe meeting moved to Friday.\u0007\n\n\n\nBring slides.\n```", EN);
    expect(body).toEqual({
      heard: "partial",
      ask: { to: "none" },
      summary: ["The meeting moved to Friday.\n\nBring slides."],
      facts: [],
    });
    expect(CardBody.safeParse(body).success).toBe(true);
  });

  it("caps the raw text without splitting a character", () => {
    const body = unformattedBody("😀".repeat(3000), EN);
    expect(body.summary[0].length).toBeLessThanOrEqual(UNFORMATTED_MAX_CHARS);
    expect(body.summary[0].endsWith("…")).toBe(true);
    expect(body.summary[0]).not.toMatch(/[\uD800-\uDBFF]…$/);
  });

  it("is never blank", () => {
    expect(unformattedBody("   ", ZH).summary).toEqual([localString("zh", "noSpeech")]);
  });
});
