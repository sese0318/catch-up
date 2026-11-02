// Mock card bodies for dev, tests and the mock provider (ux-spec 7 Modes 3). Card lane.
// Never filmed and never in the README. Every body must pass CardBody and the clamp unchanged.
import type { MockFixtureKind } from "../protocol";
import type { CardBody, CardLang } from "./schema";
import { repeatLine } from "./strings";

// Fictional people only (Mina is the listener). Dates read as if pressed on Mon Nov 2, 2026.
const FIXTURES: Readonly<Record<MockFixtureKind, Readonly<Record<CardLang, CardBody>>>> = {
  you: {
    en: {
      heard: "clear",
      ask: { to: "you", text: "Can you send the revised slides by Friday at 3 pm?", by: "Dana" },
      say: { text: "Just to check, the revised slides by this Friday at 3 pm?", lang: "en" },
      summary: [
        "Dana asked you to send the revised slides by Friday.",
        "The team will go through them before the client call next week.",
      ],
      facts: [
        { kind: "name", text: "Dana" },
        { kind: "date", text: "Fri Nov 6, 3 pm", note: "this Friday" },
        { kind: "task", text: "Send the revised slides" },
      ],
      quote: "Mina, can you send the revised slides by Friday at three?",
    },
    ja: {
      heard: "clear",
      ask: { to: "you", text: "改訂版のスライドを金曜15時までに送れますか？", by: "佐倉さん" },
      say: { text: "確認ですが、今週金曜の15時までに改訂版のスライドですね？", lang: "ja" },
      summary: ["佐倉さんから、改訂版スライドを金曜までに送るよう頼まれました。", "来週の打ち合わせの前にチームで確認する予定です。"],
      facts: [
        { kind: "name", text: "佐倉さん" },
        { kind: "date", text: "11月6日（金）15時", note: "今週の金曜日" },
        { kind: "task", text: "改訂版スライドを送る" },
      ],
      quote: "ミナさん、改訂版のスライドを金曜の15時までに送ってもらえますか？",
    },
    zh: {
      heard: "clear",
      ask: { to: "you", text: "你能在周五下午3点前把修改后的幻灯片发过来吗？", by: "林老师" },
      say: { text: "确认一下，是这周五下午3点前发修改后的幻灯片，对吗？", lang: "zh" },
      summary: ["林老师请你在周五前发送修改后的幻灯片。", "团队会在下周和客户开会前一起看。"],
      facts: [
        { kind: "name", text: "林老师" },
        { kind: "date", text: "11月6日（周五）下午3点", note: "本周五" },
        { kind: "task", text: "发送修改后的幻灯片" },
      ],
      quote: "米娜，你能在周五下午三点前把修改后的幻灯片发过来吗？",
    },
  },
  room: {
    en: {
      heard: "clear",
      ask: { to: "room", text: "Who can take notes at Thursday's planning meeting?", by: "Jordan" },
      say: { text: "Just to check, notes for Thursday's planning meeting?", lang: "en" },
      summary: ["Jordan asked the group who can take notes on Thursday.", "Nobody has said yes yet."],
      facts: [
        { kind: "date", text: "Thu Nov 5", note: "this Thursday" },
        { kind: "task", text: "Take notes at the planning meeting" },
      ],
      quote: "Okay, who can take notes at Thursday's planning meeting?",
    },
    ja: {
      heard: "clear",
      ask: { to: "room", text: "木曜の企画会議で議事録を取れる人はいますか？", by: "小野さん" },
      say: { text: "確認ですが、木曜の企画会議の議事録ですね？", lang: "ja" },
      summary: ["小野さんが、木曜の議事録係を全体に募っています。", "まだ誰も手を挙げていません。"],
      facts: [
        { kind: "date", text: "11月5日（木）", note: "今週の木曜日" },
        { kind: "task", text: "企画会議の議事録を取る" },
      ],
      quote: "じゃあ、木曜の企画会議で議事録を取れる人いますか？",
    },
    zh: {
      heard: "clear",
      ask: { to: "room", text: "周四的策划会谁能做会议记录？", by: "周经理" },
      say: { text: "确认一下，是周四策划会的会议记录吧？", lang: "zh" },
      summary: ["周经理在问大家周四谁能做会议记录。", "目前还没有人答应。"],
      facts: [
        { kind: "date", text: "11月5日（周四）", note: "本周四" },
        { kind: "task", text: "策划会做会议记录" },
      ],
      quote: "好，周四的策划会谁能做一下会议记录？",
    },
  },
  mentioned: {
    en: {
      heard: "clear",
      ask: { to: "mentioned", text: "Your survey results will open Monday's review.", by: "Priya" },
      say: { text: "Just to check, my survey results go first on Monday?", lang: "en" },
      summary: ["Priya said your survey results will open Monday's review.", "After that the team moves on to the budget."],
      facts: [
        { kind: "name", text: "Priya" },
        { kind: "date", text: "Mon Nov 9", note: "next Monday" },
        { kind: "term", text: "survey results" },
      ],
      quote: "We'll start Monday's review with Mina's survey results.",
    },
    ja: {
      heard: "clear",
      ask: { to: "mentioned", text: "月曜のレビューはあなたのアンケート結果から始めるそうです。", by: "広瀬さん" },
      say: { text: "確認ですが、月曜は私のアンケート結果からですね？", lang: "ja" },
      summary: ["広瀬さんが、月曜のレビューはあなたの結果から始めると話しました。", "その後に予算の話に移ります。"],
      facts: [
        { kind: "name", text: "広瀬さん" },
        { kind: "date", text: "11月9日（月）", note: "来週の月曜日" },
        { kind: "term", text: "アンケート結果" },
      ],
      quote: "月曜のレビューは、ミナさんのアンケート結果から始めましょう。",
    },
    zh: {
      heard: "clear",
      ask: { to: "mentioned", text: "周一的评审会从你的问卷结果开始。", by: "陈老师" },
      say: { text: "确认一下，周一先讲我的问卷结果，对吗？", lang: "zh" },
      summary: ["陈老师说周一的评审会从你的问卷结果开始。", "之后大家再讨论预算。"],
      facts: [
        { kind: "name", text: "陈老师" },
        { kind: "date", text: "11月9日（周一）", note: "下周一" },
        { kind: "term", text: "问卷结果" },
      ],
      quote: "周一的评审会，我们先从米娜的问卷结果开始。",
    },
  },
  none: {
    en: {
      heard: "clear",
      ask: { to: "none" },
      say: { text: "So the launch moves to next Friday, right?", lang: "en" },
      summary: ["The team agreed to move the launch to next Friday.", "Lee will update the timeline and tell the client."],
      facts: [
        { kind: "date", text: "Fri Nov 13", note: "next Friday" },
        { kind: "name", text: "Lee" },
        { kind: "task", text: "Update the timeline" },
      ],
      quote: "Okay, let's move the launch to next Friday, and Lee will update the timeline.",
    },
    ja: {
      heard: "clear",
      ask: { to: "none" },
      say: { text: "つまり、リリースは来週の金曜に延期ですね？", lang: "ja" },
      summary: ["リリースを来週の金曜に延期することで合意しました。", "石井さんがスケジュールを更新し、先方に連絡します。"],
      facts: [
        { kind: "date", text: "11月13日（金）", note: "来週の金曜日" },
        { kind: "name", text: "石井さん" },
        { kind: "task", text: "スケジュールを更新する" },
      ],
      quote: "じゃあリリースは来週の金曜にずらして、石井さんがスケジュールを直してください。",
    },
    zh: {
      heard: "clear",
      ask: { to: "none" },
      say: { text: "所以发布改到下周五了，对吧？", lang: "zh" },
      summary: ["大家同意把发布推迟到下周五。", "小李会更新时间表并通知客户。"],
      facts: [
        { kind: "date", text: "11月13日（周五）", note: "下周五" },
        { kind: "name", text: "小李" },
        { kind: "task", text: "更新时间表" },
      ],
      quote: "好，那发布就推到下周五，小李来更新一下时间表。",
    },
  },
  poor: {
    en: {
      heard: "poor",
      ask: { to: "none" },
      say: { text: repeatLine("en"), lang: "en" },
      summary: ["Someone mentioned a deadline, but most of it was hard to hear."],
      facts: [{ kind: "date", text: "Thursday", note: "or Tuesday", unsure: true }],
    },
    ja: {
      heard: "poor",
      ask: { to: "none" },
      say: { text: repeatLine("ja"), lang: "ja" },
      summary: ["締め切りの話が出ましたが、ほとんど聞き取れませんでした。"],
      facts: [{ kind: "date", text: "木曜日", note: "または火曜日", unsure: true }],
    },
    zh: {
      heard: "poor",
      ask: { to: "none" },
      say: { text: repeatLine("zh"), lang: "zh" },
      summary: ["有人提到了截止日期，但大部分听不清。"],
      facts: [{ kind: "date", text: "周四", note: "也可能是周二", unsure: true }],
    },
  },
  no_speech: {
    en: { heard: "none", ask: { to: "none" }, summary: ["Only background noise, no one spoke."], facts: [] },
    ja: { heard: "none", ask: { to: "none" }, summary: ["物音だけで、話し声はありませんでした。"], facts: [] },
    zh: { heard: "none", ask: { to: "none" }, summary: ["只有背景噪音，没有人说话。"], facts: [] },
  },
  // English speech with a teen number the model already flagged, in every card language.
  unsure_number: {
    en: {
      heard: "partial",
      ask: { to: "room", text: "Can every team cut its budget by 15% before the review?", by: "Morgan" },
      say: { text: "Just to check, a 15% cut before the review?", lang: "en" },
      summary: ["Morgan asked every team to cut its budget before the review.", "The exact percentage was hard to hear."],
      facts: [
        { kind: "number", text: "15%", note: "or 50%", unsure: true },
        { kind: "name", text: "Morgan" },
        { kind: "task", text: "Cut the budget before the review" },
      ],
      quote: "Can everyone trim their budget by fifteen percent before the review?",
    },
    ja: {
      heard: "partial",
      ask: { to: "room", text: "審査の前に各チームの予算を15%削れるか聞いています。", by: "Morgan" },
      say: {
        text: "Just to check, a 15% cut before the review?",
        lang: "en",
        gloss: "確認ですが、審査の前に15%削減ですか？",
      },
      summary: ["Morganが、審査の前に各チームの予算削減を求めました。", "削減率の部分が聞き取りにくかったです。"],
      facts: [
        { kind: "number", text: "15%", note: "または50%", unsure: true },
        { kind: "name", text: "Morgan" },
        { kind: "task", text: "審査の前に予算を削る" },
      ],
      quote: "Can everyone trim their budget by fifteen percent before the review?",
    },
    zh: {
      heard: "partial",
      ask: { to: "room", text: "评审前每个团队能否把预算削减15%？", by: "Morgan" },
      say: {
        text: "Just to check, a 15% cut before the review?",
        lang: "en",
        gloss: "确认一下，是评审前削减15%吗？",
      },
      summary: ["Morgan要求各团队在评审前削减预算。", "具体比例那部分听不太清。"],
      facts: [
        { kind: "number", text: "15%", note: "也可能是50%", unsure: true },
        { kind: "name", text: "Morgan" },
        { kind: "task", text: "评审前削减预算" },
      ],
      quote: "Can everyone trim their budget by fifteen percent before the review?",
    },
  },
  // Code-switching. en has Japanese speech, ja has English speech, zh mixes Mandarin and English.
  mixed: {
    en: {
      heard: "clear",
      ask: { to: "you", text: "Can you review the PR before tomorrow's demo?", by: "Ren" },
      say: {
        text: "確認ですが、明日のデモの前にPRのレビューですね？",
        lang: "ja",
        gloss: "Just to check, review the PR before tomorrow's demo?",
      },
      summary: ["Ren asked you to review the PR before tomorrow's demo.", "The demo with the design team starts at 10 am."],
      facts: [
        { kind: "term", text: "PR", note: "pull request" },
        { kind: "date", text: "Tue Nov 3, 10 am", note: "tomorrow" },
        { kind: "name", text: "Ren" },
      ],
      quote: "ミナさん、明日のdemoの前にPRをreviewしてもらえますか？",
    },
    ja: {
      heard: "clear",
      ask: { to: "you", text: "明日のデモの前にPRをレビューできるか聞かれています。", by: "Ren" },
      say: {
        text: "Just to check, review the PR before tomorrow's demo?",
        lang: "en",
        gloss: "確認ですが、明日のデモの前にPRのレビューですね？",
      },
      summary: ["Renさんから、明日のデモの前にPRのレビューを頼まれました。", "デモはデザインチームと午前10時からです。"],
      facts: [
        { kind: "term", text: "PR", note: "プルリクエスト" },
        { kind: "date", text: "11月3日（火）10時", note: "明日" },
        { kind: "name", text: "Ren" },
      ],
      quote: "Mina, could you review the PR before tomorrow's demo? 明日の10時からね。",
    },
    zh: {
      heard: "clear",
      ask: { to: "you", text: "明天demo之前你能review一下这个PR吗？", by: "小王" },
      say: { text: "确认一下，是明天demo之前review这个PR，对吗？", lang: "zh" },
      summary: ["小王请你在明天的demo之前review这个PR。", "demo是明天上午10点，和设计团队一起。"],
      facts: [
        { kind: "term", text: "PR", note: "pull request，代码合并请求" },
        { kind: "date", text: "11月3日（周二）上午10点", note: "明天" },
        { kind: "name", text: "小王" },
      ],
      quote: "米娜，明天demo之前你能review一下这个PR吗？",
    },
  },
};

/**
 * One body per kind (you, room, mentioned, none, poor, no_speech, unsure_number, mixed) in
 * en, ja and zh. Fictional names only.
 */
export function mockCardBody(kind: MockFixtureKind, lang: CardLang): CardBody {
  return structuredClone(FIXTURES[kind][lang]);
}
