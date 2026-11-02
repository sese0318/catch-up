import { describe, expect, it } from "vitest";
import { copyRuleProblems } from "../copy-rules";
import { MOCK_FIXTURE_KINDS } from "../protocol";
import { cappedFields, fieldsOverCap } from "./caps";
import { mockCardBody } from "./fixtures";
import { applyNumberBackstop, clampCardBody } from "./parse";
import { CARD_LANGS, CardBody, MAX_FACTS, WINDOW_SECONDS } from "./schema";
import { LOCAL_STRING_KEYS, LOCAL_STRINGS, headsUpLine, localString, repeatLine, stallLine } from "./strings";

describe("mock fixtures", () => {
  for (const kind of MOCK_FIXTURE_KINDS) {
    for (const lang of CARD_LANGS) {
      it(`${kind} in ${lang} is a clean card within the caps`, () => {
        const body = mockCardBody(kind, lang);
        expect(CardBody.safeParse(body).success).toBe(true);
        for (const meetingLang of CARD_LANGS) {
          const clamped = clampCardBody(body, { cardLang: lang, meetingLang });
          expect(clamped?.quality, `meeting ${meetingLang}`).toBe("clean");
          expect(clamped?.body).toEqual(body);
        }
        expect(applyNumberBackstop(body)).toEqual(body);
        expect(body.facts.length).toBeLessThanOrEqual(MAX_FACTS);
        expect(cappedFields(body).length).toBeGreaterThan(0);
        expect(fieldsOverCap(body)).toEqual([]);
      });
    }
  }

  it("follows the heard rules", () => {
    for (const lang of CARD_LANGS) {
      const poor = mockCardBody("poor", lang);
      expect(poor.heard).toBe("poor");
      expect(poor.say).toEqual({ text: repeatLine(lang), lang });
      const none = mockCardBody("no_speech", lang);
      expect(none).toMatchObject({ heard: "none", ask: { to: "none" }, facts: [] });
      expect(none.say).toBeUndefined();
      expect(none.summary).toHaveLength(1);
    }
  });

  it("covers every ask state and an unsure teen number", () => {
    expect(mockCardBody("you", "en").ask.to).toBe("you");
    expect(mockCardBody("room", "ja").ask.to).toBe("room");
    expect(mockCardBody("mentioned", "zh").ask.to).toBe("mentioned");
    expect(mockCardBody("none", "en").ask.to).toBe("none");
    for (const lang of CARD_LANGS) {
      const fact = mockCardBody("unsure_number", lang).facts.find((f) => f.kind === "number");
      expect(fact).toMatchObject({ text: "15%", unsure: true });
      expect(fact?.note).toContain("50%");
    }
  });

  it("mixes languages with a gloss in the card language", () => {
    expect(mockCardBody("mixed", "en").say).toMatchObject({ lang: "ja", gloss: expect.any(String) });
    expect(mockCardBody("mixed", "ja").say).toMatchObject({ lang: "en", gloss: expect.any(String) });
    expect(mockCardBody("mixed", "zh").say?.gloss).toBeUndefined();
  });

  it("returns a fresh copy every time", () => {
    const first = mockCardBody("you", "en");
    first.summary[0] = "changed";
    first.facts.length = 0;
    expect(mockCardBody("you", "en").summary[0]).not.toBe("changed");
    expect(mockCardBody("you", "en").facts.length).toBeGreaterThan(0);
  });
});

describe("local strings", () => {
  it("has every key in every card language", () => {
    for (const lang of CARD_LANGS) {
      for (const key of LOCAL_STRING_KEYS) expect(localString(lang, key).length, `${lang} ${key}`).toBeGreaterThan(0);
      expect(Object.keys(LOCAL_STRINGS[lang]).sort()).toEqual([...LOCAL_STRING_KEYS].sort());
    }
  });

  it("matches the ux-spec 2-7 table", () => {
    expect(stallLine("en")).toBe("Let me think about that for a second.");
    expect(stallLine("ja")).toBe("少し考えさせてください。");
    expect(stallLine("zh")).toBe("让我想一下。");
    expect(repeatLine("en")).toBe("Sorry, could you say that last part again?");
    expect(repeatLine("ja")).toBe("すみません、最後のところをもう一度お願いできますか。");
    expect(repeatLine("zh")).toBe("不好意思，最后那部分能再说一遍吗？");
    expect(localString("ja", "poor")).toBe("聞き取りにくい音声でした。細部が違うかもしれません");
    expect(localString("zh", "sayNone")).toBe("想接话的话");
    expect(localString("en", "aiTag")).toBe("AI-suggested");
  });

  it("keeps the English strings inside the writing rules", () => {
    for (const key of LOCAL_STRING_KEYS) expect(copyRuleProblems(localString("en", key)), key).toEqual([]);
  });

  it("fills the window seconds into the heads-up line", () => {
    for (const windowSec of WINDOW_SECONDS) {
      expect(headsUpLine("en", windowSec)).toContain(`the last ${windowSec} seconds of audio`);
      expect(headsUpLine("ja", windowSec)).toContain(`直前${windowSec}秒の音声`);
      expect(headsUpLine("zh", windowSec)).toContain(`最近${windowSec}秒的音频`);
      expect(copyRuleProblems(headsUpLine("en", windowSec))).toEqual([]);
    }
    expect(headsUpLine("en", 30)).toBe(
      "Heads up, I use Catch Up, an AI accessibility tool. Only when I tap, it sends the last 30 seconds of audio to an AI model for a short recap. Catch Up saves nothing. Tell me if you'd rather I turn it off.",
    );
    expect(headsUpLine("ja", 30)).toBe(
      "お知らせです。聞き逃し対策のAIアクセシビリティツール Catch Up を使っています。私がタップしたときだけ直前30秒の音声をAIに送って短い要約を出し、何も保存しません。止めてほしければ言ってください。",
    );
    expect(headsUpLine("zh", 30)).toBe(
      "提醒一下，我在用AI无障碍辅助工具 Catch Up。只有在我点按时，它才会把最近30秒的音频发给AI生成简短摘要，不保存任何内容。如果介意请告诉我，我会关掉。",
    );
  });
});
