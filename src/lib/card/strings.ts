// Local strings in the card language (ux-spec 2-7 and 5). Card lane. Never from the model.
// App chrome (buttons, settings, states) stays English and lives in the UI lane.
import type { CardLang } from "./schema";

export const LOCAL_STRING_KEYS = [
  "stall", // Let me think about that for a second.
  "repeat", // fallback say line
  "stallLabel", // If they're waiting on you
  "askedYou",
  "room",
  "mentioned",
  "none",
  "sayAsked", // To check, say
  "sayNone", // To jump back in
  "aiTag", // AI-suggested
  "glossLabel", // Means
  "evidence", // What they said
  "unsure", // Check
  "partial",
  "poor",
  "noSpeech",
] as const;
export type LocalStringKey = (typeof LOCAL_STRING_KEYS)[number];

export const LOCAL_STRINGS: Readonly<Record<CardLang, Readonly<Record<LocalStringKey, string>>>> = {
  en: {
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
  },
  ja: {
    stall: "少し考えさせてください。",
    repeat: "すみません、最後のところをもう一度お願いできますか。",
    stallLabel: "待たせているなら",
    askedYou: "あなたへの質問",
    room: "全体への質問",
    mentioned: "名前が出ました",
    none: "質問はされていません",
    sayAsked: "確認のひとこと",
    sayNone: "話に戻るなら",
    aiTag: "AIの提案",
    glossLabel: "意味",
    evidence: "実際の発言",
    unsure: "要確認",
    partial: "一部聞き取りにくい箇所がありました",
    poor: "聞き取りにくい音声でした。細部が違うかもしれません",
    noSpeech: "話し声を聞き取れませんでした",
  },
  zh: {
    stall: "让我想一下。",
    repeat: "不好意思，最后那部分能再说一遍吗？",
    stallLabel: "如果对方在等你",
    askedYou: "在问你",
    room: "在问大家",
    mentioned: "提到了你",
    none: "没有人问你",
    sayAsked: "这样确认",
    sayNone: "想接话的话",
    aiTag: "AI建议",
    glossLabel: "意思",
    evidence: "原话",
    unsure: "需确认",
    partial: "部分内容听不太清",
    poor: "音频不太清楚，细节可能有误",
    noSpeech: "没有听到清楚的说话声",
  },
};

/** The ux-spec 2-7 table, exactly as written there, for en, ja and zh. */
export function localString(lang: CardLang, key: LocalStringKey): string {
  return LOCAL_STRINGS[lang][key];
}

/** Shown at press time in the meeting language. */
export function stallLine(lang: CardLang): string {
  return localString(lang, "stall");
}

/** The polite repeat request used when heard is poor. */
export function repeatLine(lang: CardLang): string {
  return localString(lang, "repeat");
}

/**
 * The heads-up line from ux-spec 5. It names the most a press can send (2 minutes), not the window
 * picked now, because the window chips stay live while listening and Further back steps a held clip
 * up to 2 minutes. A line people were shown must never understate what leaves.
 */
export function headsUpLine(lang: CardLang): string {
  switch (lang) {
    case "ja":
      return (
        "お知らせです。聞き逃し対策のAIアクセシビリティツール Catch Up を使っています。" +
        "私がタップしたときだけ直前最大2分の音声をAIに送って短い要約を出し、何も保存しません。" +
        "止めてほしければ言ってください。"
      );
    case "zh":
      return (
        "提醒一下，我在用AI无障碍辅助工具 Catch Up。" +
        "只有在我点按时，它才会把最近最多2分钟的音频发给AI生成简短摘要，不保存任何内容。" +
        "如果介意请告诉我，我会关掉。"
      );
    default:
      return (
        "Heads up, I use Catch Up, an AI accessibility tool. " +
        "Only when I tap, it sends up to the last 2 minutes of audio to an AI model for a short recap. " +
        "Catch Up saves nothing. Tell me if you'd rather I turn it off."
      );
  }
}
