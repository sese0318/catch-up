import { describe, expect, it } from "vitest";
import { clipToWidth, splitFirstSentence, widthOf } from "./width";

describe("clipToWidth", () => {
  it("returns text within the cap unchanged", () => {
    expect(clipToWidth("Just to check, Friday?", 110)).toBe("Just to check, Friday?");
    expect(clipToWidth("確認ですが、金曜ですね？", 24)).toBe("確認ですが、金曜ですね？");
    expect(clipToWidth("确认一下，是周五吗？", 20)).toBe("确认一下，是周五吗？");
  });

  it("cuts English at a word boundary and drops the trailing comma", () => {
    const out = clipToWidth("Just to check, this Friday at 3 pm in the small room?", 16);
    expect(out).toBe("Just to check…");
    expect(widthOf(out)).toBeLessThanOrEqual(16);
  });

  it("keeps a percent sign in front of the ellipsis", () => {
    expect(clipToWidth("Cut the budget by 15% before the review starts", 22)).toBe("Cut the budget by 15%…");
  });

  it("cuts Japanese and Chinese at a phrase boundary in width units", () => {
    const ja = "来週の水曜日の午後3時に会議があります。";
    const jaOut = clipToWidth(ja, 20);
    expect(widthOf(jaOut)).toBeLessThanOrEqual(20);
    expect(jaOut.endsWith("…")).toBe(true);
    expect(ja.startsWith(jaOut.slice(0, -1))).toBe(true);
    expect(jaOut).toBe("来週の水曜日の午後3…");

    const zh = "下周三下午三点开会，请大家准时参加。";
    const zhOut = clipToWidth(zh, 21);
    expect(widthOf(zhOut)).toBeLessThanOrEqual(21);
    expect(zhOut).toBe("下周三下午三点开会…");
  });

  it("clips mixed scripts without breaking a word", () => {
    const mixed = "明日のdemoの前にPRをreviewしてもらえますか？";
    const out = clipToWidth(mixed, 24);
    expect(widthOf(out)).toBeLessThanOrEqual(24);
    expect(mixed.startsWith(out.slice(0, -1))).toBe(true);
    expect(out).not.toMatch(/revi…|rev…|re…/);
  });

  it("falls back to a grapheme cut when the first word is wider than the cap", () => {
    expect(clipToWidth("Supercalifragilisticexpialidocious", 10)).toBe("Supercali…");
    const emoji = clipToWidth("👍🏽👍🏽👍🏽", 5);
    expect(emoji).toBe("👍🏽…");
    expect(widthOf(emoji)).toBe(5);
  });

  it("returns an empty string for a cap with no room", () => {
    expect(clipToWidth("hello", 0)).toBe("");
    expect(clipToWidth("hello", 1)).toBe("…");
  });

  it("stays within the cap for many lengths and scripts", () => {
    const texts = [
      "The quick brown fox jumps over the lazy dog near the riverbank at dawn.",
      "聞き取りにくい音声でした。細部が違うかもしれません。もう一度確認してください。",
      "音频不太清楚，细节可能有误，请再确认一次时间和地点。",
      "Seika, セイカ, 星佳 said the PR is ready for review 明日.",
    ];
    for (const text of texts) {
      for (let cap = 2; cap <= 60; cap++) {
        const out = clipToWidth(text, cap);
        expect(widthOf(out), `${text} at ${cap}`).toBeLessThanOrEqual(cap);
        if (widthOf(text) > cap) expect(out.endsWith("…")).toBe(true);
      }
    }
  });
});

describe("splitFirstSentence", () => {
  it("splits after the first sentence and keeps the rest", () => {
    expect(splitFirstSentence("The demo moved. Lee will tell the client.")).toEqual([
      "The demo moved.",
      "Lee will tell the client.",
    ]);
    expect(splitFirstSentence("佐倉さんから頼まれました。来週確認します。", "ja")).toEqual([
      "佐倉さんから頼まれました。",
      "来週確認します。",
    ]);
    expect(splitFirstSentence("只有背景噪音，没有人说话。")).toEqual(["只有背景噪音，没有人说话。", ""]);
  });

  it("does not split after a title or a time abbreviation", () => {
    expect(splitFirstSentence("Dr. Smith moved it to 3 p.m. on Friday. Then they left.")).toEqual([
      "Dr. Smith moved it to 3 p.m. on Friday.",
      "Then they left.",
    ]);
  });
});
