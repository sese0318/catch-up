// Sample conversations for the landing page and the sample flow (ux-spec 3 and 9 item 6).
// Eval lane. Public clips need written consent. Synthetic test clips live in public/samples/dev
// (git-ignored, never shipped) and are listed only outside production.
// Browser safe. The press pipeline and the UI import this file, so it never imports fs, path,
// node: modules or server code, and it never lists a folder at run time.
import type { MuffleWindow } from "../audio/types";
import type { Card, CardLang, SayLang } from "../card/schema";
import cachedCardsJson from "./cached-cards.json";

/** One line of a sample's script, for captions and What they said. Speaker names are fictional. */
export interface SampleLine {
  speaker: string;
  lang: SayLang; // main language of the line, for the lang attribute. Mixed lines keep their words as spoken
  text: string;
}

export interface SampleClip {
  id: string; // kebab-case, also the file stem
  title: string; // English chrome, for example "An English ask by name"
  blurb: string;
  url: string; // under /samples/, a WAV or MP3 any browser can decode
  durationSec: number; // under 30
  spokenLangs: readonly SayLang[];
  muffle: MuffleWindow; // about 4 s around the key sentence
  keyMomentSec: number; // the button pulses once after this
  consent: "written" | "synthetic";
  /** Saved real results with meta.route "cached", meta.cachedFrom and meta.cachedRunAt. Empty until gate 1. */
  cached: Partial<Record<CardLang, Card>>;
  /**
   * The forms people in the clip call the listener. A sample press should send these as names,
   * because the clip asks a fictional listener (Sam) by name, and the visitor's own names would
   * turn that ask into a question to the room.
   */
  listenerNames?: readonly string[];
  /** The language most people in the clip speak, for the stall line and the ASR hint of a sample press. */
  meetingLang?: CardLang;
  /** The script as spoken, line by line. */
  transcript?: readonly SampleLine[];
}

/** Saved real cards by clip id and card language, written by scripts/save-cached-card.ts. */
const CACHED_CARDS = cachedCardsJson as unknown as Readonly<Record<string, Partial<Record<CardLang, Card>>>>;

/**
 * Public clips with written consent, without their cached cards. Empty until consenting voices
 * record the sample scripts in eval/clips.json (use "sample"). Each entry has a WAV or MP3 under
 * /samples/ (never /samples/dev/) and consent "written".
 */
const PUBLIC_CLIPS: readonly Omit<SampleClip, "cached">[] = [];

/** Public clips with written consent, each with its saved real cards. */
export const SAMPLE_CLIPS: readonly SampleClip[] = PUBLIC_CLIPS.map((clip) => ({
  ...clip,
  cached: CACHED_CARDS[clip.id] ?? {},
}));

const SAM = ["Sam", "サム", "萨姆"] as const;

/**
 * Synthetic dev clips, a static list written to match eval/clips.json, with fixed file names under
 * /samples/dev/ that scripts/make-synthetic-clips.ps1 creates. consent "synthetic", never cached.
 * eval/clips.test.ts checks every field against the scripts.
 */
export const DEV_SAMPLE_CLIPS: readonly SampleClip[] = [
  {
    id: "sample-ask-by-name",
    title: "An English ask by name",
    blurb: "A teammate asks Sam to pick a day for the demo.",
    url: "/samples/dev/sample-ask-by-name.wav",
    durationSec: 18,
    spokenLangs: ["en"],
    muffle: { startSec: 11.6, endSec: 16.7 },
    keyMomentSec: 16.7,
    consent: "synthetic",
    cached: {},
    listenerNames: SAM,
    meetingLang: "en",
    transcript: [
      { speaker: "Marcus", lang: "en", text: "Okay, last thing before we wrap up. The client wants a live demo this week." },
      { speaker: "Lena", lang: "en", text: "I can prep the slides, but I'm out on Friday." },
      { speaker: "Marcus", lang: "en", text: "Sam, does Thursday work for the demo, or should we push it to Monday?" },
    ],
  },
  {
    id: "sample-three-languages",
    title: "English, Japanese and Chinese in one talk",
    blurb: "A study group sets a deadline in three languages, then asks Sam for help.",
    url: "/samples/dev/sample-three-languages.wav",
    durationSec: 23,
    spokenLangs: ["en", "ja", "zh"],
    muffle: { startSec: 16.7, endSec: 21.7 },
    keyMomentSec: 21.7,
    consent: "synthetic",
    cached: {},
    listenerNames: SAM,
    meetingLang: "en",
    transcript: [
      { speaker: "Dana", lang: "en", text: "Okay, quick check on the group project." },
      { speaker: "Marcus", lang: "en", text: "So the 締め切り is 下周三, right?" },
      { speaker: "Xiaoyu", lang: "zh", text: "对，下周三。张老师说了，不要迟到。" },
      { speaker: "Aoi", lang: "ja", text: "じゃあ、スライドは私が作るね。" },
      { speaker: "Dana", lang: "en", text: "Great. Sam, can you book the study room for this Friday?" },
    ],
  },
  {
    id: "sample-office-hours",
    title: "Office hours with a name and a number",
    blurb: "A TA gives her name, a grade weight and a due date.",
    url: "/samples/dev/sample-office-hours.wav",
    durationSec: 18,
    spokenLangs: ["en"],
    muffle: { startSec: 10.5, endSec: 15 },
    keyMomentSec: 16.7,
    consent: "synthetic",
    cached: {},
    listenerNames: SAM,
    meetingLang: "en",
    transcript: [
      { speaker: "Siobhan", lang: "en", text: "Hi, come on in. I'm Siobhan, the TA for this section." },
      { speaker: "Siobhan", lang: "en", text: "So, about the final paper." },
      { speaker: "Siobhan", lang: "en", text: "It's fifteen percent of your grade, and it's due on the thirteenth." },
      { speaker: "Siobhan", lang: "en", text: "Does that sound okay?" },
    ],
  },
];

/** What the sample strip shows. Adds DEV_SAMPLE_CLIPS when NODE_ENV is not production. */
export function listSampleClips(): readonly SampleClip[] {
  if (process.env.NODE_ENV === "production" || DEV_SAMPLE_CLIPS.length === 0) return SAMPLE_CLIPS;
  return [...SAMPLE_CLIPS, ...DEV_SAMPLE_CLIPS];
}

export function getSampleClip(id: string): SampleClip | null {
  return listSampleClips().find((clip) => clip.id === id) ?? null;
}

/** The saved real card for a clip in a card language, or null. */
export function getCachedCard(id: string, lang: CardLang): Card | null {
  return getSampleClip(id)?.cached[lang] ?? null;
}
