import { describe, expect, it } from "vitest";
import { copyRuleProblems } from "../copy-rules";
import { cardToPlainText, cardsToMarkdown, langTag, receiptText, scriptLangOf } from "./format";
import { Card, routeLabelOf, type CardBody, type CardMeta } from "./schema";

const meta: CardMeta = {
  id: "c1",
  pressedAt: "2026-11-02T10:42:40.123-05:00",
  windowSec: 30,
  sentSec: 30,
  cardLang: "en",
  source: "mic",
  route: "open_weights",
  model: "meta-models/muse-spark-open-1026",
  ms: { total: 2900 },
  bytesSent: 960_044,
  sent: { body: "audio", names: true, hint: false },
};

const enBody: CardBody = {
  heard: "clear",
  ask: { to: "you", text: "Can you send the slides by Friday?", by: "Dana" },
  say: { text: "Just to check, the slides by this Friday?", lang: "en" },
  summary: ["Dana asked you to send the slides by Friday.", "The client call is next week."],
  facts: [
    { kind: "name", text: "Dana" },
    { kind: "number", text: "15%", note: "or 50%", unsure: true },
  ],
  quote: "Mina, can you send the slides by Friday?",
};

const jaBody: CardBody = {
  heard: "partial",
  ask: { to: "you", text: "デモは木曜でいいか、月曜に延ばすか", by: "Alex" },
  say: {
    text: "Just to check, Thursday for the demo, or push to Monday?",
    lang: "en",
    gloss: "確認です。デモは木曜ですか、月曜に延ばしますか。",
  },
  summary: ["デモの日程を聞かれた"],
  facts: [{ kind: "date", text: "木曜", note: "11月5日" }],
  quote: "Seika, are we good for Thursday?",
};

function card(body: CardBody, patch: Partial<CardMeta> = {}): Card {
  return Card.parse({ ...body, meta: { ...meta, ...patch } });
}

function expectReceiptRules(text: string) {
  expect(copyRuleProblems(text)).toEqual([]);
  expect(text.endsWith("Catch Up saved nothing.")).toBe(true);
  expect(text).not.toMatch(/nothing (is )?saved/i);
}

describe("scriptLangOf and langTag", () => {
  it("reads kana as ja, Han only as zh-Hans and the rest as en", () => {
    expect(scriptLangOf("こんにちは")).toBe("ja");
    expect(scriptLangOf("カタカナ")).toBe("ja");
    expect(scriptLangOf("明日のdemo")).toBe("ja");
    expect(scriptLangOf("你好")).toBe("zh-Hans");
    expect(scriptLangOf("东京大学")).toBe("zh-Hans");
    expect(scriptLangOf("hello")).toBe("en");
    expect(scriptLangOf("PR")).toBe("en");
    expect(scriptLangOf("")).toBe("en");
  });

  it("tags zh as zh-Hans and other as und", () => {
    expect(langTag("en")).toBe("en");
    expect(langTag("ja")).toBe("ja");
    expect(langTag("zh")).toBe("zh-Hans");
    expect(langTag("other")).toBe("und");
  });
});

describe("receiptText", () => {
  it("names the window, route, model, seconds and press time on Route B", () => {
    const text = receiptText(card(enBody));
    expect(text).toBe(
      "Sent the last 30 s of audio, your name and card language to Muse Spark Open on Baseten (meta-models/muse-spark-open-1026) at 10:42:40. Card in 2.9 s. Catch Up saved nothing.",
    );
    expectReceiptRules(text);
  });

  it("names the sample's listener, not the visitor, on a sample press", () => {
    const text = receiptText(card(enBody, { source: "sample" }));
    expect(text).toContain("Sent the last 30 s of audio, the sample's listener name and card language to");
    expect(text).not.toContain("your name");
    expectReceiptRules(text);
  });

  it("names both routes when the backup route answered", () => {
    const text = receiptText(
      card(enBody, {
        route: "meta_api",
        model: "muse-voice-transcribe-1.0 + muse-spark-1.3",
        fallbackFrom: "open_weights",
        windowSec: 60,
        sentSec: 60,
        ms: { total: 6100 },
        sent: { body: "audio", names: false, hint: true },
        transcript: "Can you send the slides by Friday?",
      }),
    );
    expect(text).toBe(
      "Sent the last 60 s of audio, your hint and card language to Muse Spark Open on Baseten and then, by the backup route, to Muse Voice Transcribe and Muse Spark on Meta Model API (muse-voice-transcribe-1.0 + muse-spark-1.3) at 10:42:40. Card in 6.1 s. Catch Up saved nothing.",
    );
    expectReceiptRules(text);
  });

  it("says when only the earlier transcript left the device", () => {
    const text = receiptText(
      card(jaBody, {
        cardLang: "ja",
        route: "meta_api",
        model: "muse-spark-1.3",
        pressedAt: "2026-11-02T10:43:05.000-05:00",
        ms: { total: 3400 },
        bytesSent: 120,
        sent: { body: "transcript", names: true, hint: true },
      }),
    );
    expect(text).toBe(
      "Sent the earlier transcript of the last 30 s, your name, your hint and card language to Muse Voice Transcribe and Muse Spark on Meta Model API (muse-spark-1.3) at 10:43:05. Card in 3.4 s. Catch Up saved nothing.",
    );
    expectReceiptRules(text);
  });

  it("says when memory held less than the window", () => {
    const text = receiptText(card(enBody, { sentSec: 12.2, sent: { body: "audio", names: false, hint: false } }));
    expect(text).toContain("Sent the last 12 s of audio (all there was for the 30 s window) and card language to");
    expectReceiptRules(text);
  });

  it("explains a saved result without claiming a model got this press", () => {
    const fromB = receiptText(
      card(enBody, {
        route: "cached",
        cachedFrom: "open_weights",
        cachedRunAt: "2026-11-03",
        cachedBecause: "live_off",
        sent: { body: "none", names: false, hint: false },
        bytesSent: 0,
      }),
    );
    expect(fromB).toBe(
      "Live cards are paused for now. Saved result from Muse Spark Open (meta-models/muse-spark-open-1026), run Nov 3, 2026, card in 2.9 s. Nothing left your device at 10:42:40. Catch Up saved nothing.",
    );
    expectReceiptRules(fromB);

    const fromA = receiptText(
      card(enBody, {
        route: "cached",
        model: "muse-voice-transcribe-1.0 + muse-spark-1.3",
        cachedFrom: "meta_api",
        cachedRunAt: "2026-11-03T14:05:00Z",
        cachedBecause: "provider_error",
        ms: { total: 6100 },
      }),
    );
    expect(fromA).toBe(
      "The model service returned an error. Saved result from Muse Voice Transcribe and Muse Spark (muse-voice-transcribe-1.0 + muse-spark-1.3), run Nov 3, 2026, card in 6.1 s. This press at 10:42:40 sent the last 30 s of audio, your name and card language, and no live card came back. Catch Up saved nothing.",
    );
    expectReceiptRules(fromA);
    for (const text of [fromB, fromA]) {
      expect(text).not.toMatch(/ to Muse/);
      expect(text).toContain(routeLabelOf({ route: "cached", cachedFrom: text === fromB ? "open_weights" : "meta_api" }));
    }
  });

  it("gives every cached reason in plain English", () => {
    for (const cachedBecause of ["rate_limited", "daily_cap", "not_configured", "timeout", "server_error", "offline", "network", "aborted"] as const) {
      const text = receiptText(
        card(enBody, { route: "cached", cachedFrom: "open_weights", cachedRunAt: "2026-11-03", cachedBecause }),
      );
      expectReceiptRules(text);
    }
    const noReason = receiptText(card(enBody, { route: "cached", cachedFrom: "open_weights", cachedRunAt: "2026-11-03" }));
    expect(noReason.startsWith("This card comes from a saved run.")).toBe(true);
    expectReceiptRules(noReason);
  });

  it("says no model was called for a mock card", () => {
    const text = receiptText(card(enBody, { route: "mock", model: "mock" }));
    expect(text).toBe("Sample card, no model was called. Catch Up saved nothing.");
    expectReceiptRules(text);
  });

  it("shows the press time in another time zone when asked", () => {
    expect(receiptText(card(enBody), { timeZone: "Asia/Tokyo" })).toContain(" at 00:42:40.");
    expect(receiptText(card(enBody), { timeZone: "Not/AZone" })).toContain(" at 10:42:40.");
  });
});

describe("cardToPlainText", () => {
  it("copies an English card in panic order", () => {
    const text = cardToPlainText(card(enBody));
    expect(text).toBe(
      [
        "Asked you",
        "Can you send the slides by Friday? (Dana)",
        "",
        "To check, say (AI-suggested)",
        "Just to check, the slides by this Friday?",
        "",
        "Dana asked you to send the slides by Friday.",
        "The client call is next week.",
        "",
        "• Dana",
        "• 15% (Check, or 50%)",
        "",
        "What they said",
        '"Mina, can you send the slides by Friday?"',
      ].join("\n"),
    );
    expect(copyRuleProblems(text)).toEqual([]);
  });

  it("labels a Japanese card in Japanese and keeps the say line as spoken", () => {
    const text = cardToPlainText(card(jaBody, { cardLang: "ja" }));
    expect(text).toBe(
      [
        "あなたへの質問",
        "デモは木曜でいいか、月曜に延ばすか（Alex）",
        "",
        "確認のひとこと（AIの提案）",
        "Just to check, Thursday for the demo, or push to Monday?",
        "意味「確認です。デモは木曜ですか、月曜に延ばしますか。」",
        "",
        "一部聞き取りにくい箇所がありました",
        "デモの日程を聞かれた",
        "",
        "• 木曜（11月5日）",
        "",
        "実際の発言",
        '"Seika, are we good for Thursday?"',
      ].join("\n"),
    );
  });

  it("uses the jump back in label when nothing was asked, and the no speech line for heard none", () => {
    const zh = cardToPlainText(
      card(
        { heard: "clear", ask: { to: "none" }, say: { text: "所以发布改到下周五了，对吧？", lang: "zh" }, summary: ["大家同意推迟发布。"], facts: [] },
        { cardLang: "zh" },
      ),
    );
    expect(zh).toBe(["没有人问你", "", "想接话的话（AI建议）", "所以发布改到下周五了，对吧？", "", "大家同意推迟发布。"].join("\n"));
    const none = cardToPlainText(card({ heard: "none", ask: { to: "none" }, summary: ["Only background noise."], facts: [] }));
    expect(none).toBe("Couldn't make out any speech\nOnly background noise.");
  });

  it("copies the raw text of an Unformatted card", () => {
    const raw = card({ heard: "partial", ask: { to: "none" }, summary: ["The model said\nsomething."], facts: [] }, { unformatted: true });
    expect(cardToPlainText(raw)).toBe("The model said\nsomething.");
  });
});

describe("cardsToMarkdown", () => {
  const older = card(enBody, { id: "a", pressedAt: "2026-11-02T10:42:40.123-05:00" });
  const newer = card(
    { ...enBody, summary: ["*Bold* <b>tag</b> [link](x) and #hash"] },
    { id: "b", pressedAt: "2026-11-02T10:50:02.000-05:00", route: "meta_api", model: "muse-voice-transcribe-1.0 + muse-spark-1.3" },
  );

  it("exports the session oldest first with each receipt", () => {
    const md = cardsToMarkdown([newer, older], { exportedAt: new Date(2026, 10, 2, 10, 55) });
    expect(md.startsWith("# Catch Up session\n\nExported 2026-11-02 10:55. 2 cards. Cards are written by AI and can be wrong.\n")).toBe(
      true,
    );
    expect(md.indexOf("## Catch-up at 10:42")).toBeGreaterThan(0);
    expect(md.indexOf("## Catch-up at 10:42")).toBeLessThan(md.indexOf("## Catch-up at 10:50"));
    expect(md).toContain(`_${receiptText(older)}_`);
    expect(md).toContain(`_${receiptText(newer)}_`);
    expect(md).toContain("**To check, say (AI-suggested)**");
    expect(md).toContain("* 15% (Check, or 50%)");
    expect(md).toContain('> "Mina, can you send the slides by Friday?"');
    expect(md.endsWith("\n")).toBe(true);
    expect(copyRuleProblems("Exported 2026-11-02 10:55. 2 cards. Cards are written by AI and can be wrong.")).toEqual([]);
  });

  it("escapes Markdown and HTML in card text", () => {
    const md = cardsToMarkdown([newer]);
    expect(md).toContain("\\*Bold\\* \\<b\\>tag\\</b\\> \\[link\\](x) and #hash");
    expect(md).not.toContain("<b>");
    const listy = cardsToMarkdown([card({ ...enBody, summary: ["1. First point", "# Not a heading"] })]);
    expect(listy).toContain("\n1\\. First point\n");
    expect(listy).toContain("\n\\# Not a heading\n");
    expect(md.startsWith("# Catch Up session\n\n1 card. Cards are written by AI and can be wrong.\n")).toBe(true);
  });

  it("quotes the raw text of an Unformatted card", () => {
    const raw = card({ heard: "partial", ask: { to: "none" }, summary: ["line one\nline two"], facts: [] }, { unformatted: true });
    const md = cardsToMarkdown([raw]);
    expect(md).toContain("**Unformatted**\n\n> line one\n> line two");
  });
});
