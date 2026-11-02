// eval/clips.json, its schema and the press metadata each clip is sent with.
// Used by the eval runner and the tests. Node only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AskTo, CardLang, Heard, SayLang, Source, WINDOW_SECONDS, type WindowSec } from "@/lib/card/schema";
import {
  LIMITS,
  PROTOCOL_VERSION,
  normalizeHint,
  normalizeNames,
  toLocalIso,
  type MockFixtureKind,
  type MockSpec,
  type PressMeta,
  type RoutePreference,
} from "@/lib/protocol";

export const CLIPS_PATH = fileURLToPath(new URL("./clips.json", import.meta.url));
export const EVAL_DIR = fileURLToPath(new URL(".", import.meta.url));

export const CLIP_USES = ["eval", "sample", "control"] as const;
export type ClipUse = (typeof CLIP_USES)[number];
export const EFFECTS = ["none", "call", "room", "far"] as const;
export const NOISE_KINDS = ["room", "cafe", "noise"] as const;

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const VoiceSpec = z.strictObject({
  name: z.string().min(1), // an installed Windows voice, for example Microsoft Zira Desktop
  lang: z.enum(["en", "ja", "zh"]),
  rate: z.number().int().min(-10).max(10),
  pitch: z.number().min(0.8).max(1.25),
});
export type VoiceSpec = z.infer<typeof VoiceSpec>;

export const ScriptLine = z.strictObject({
  speaker: z.string().min(1), // fictional
  voice: z.string().min(1), // a key of voices
  lang: SayLang, // main language of the line
  text: z.string().min(1), // what is said, as a transcript would show it
  tts: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(1).optional(), // [voice key, text] segments when the synthetic voice needs help
  at: z.number().nonnegative().optional(),
  gap: z.number().nonnegative().optional(),
});
export type ScriptLine = z.infer<typeof ScriptLine>;

/** A name or term the card should hold, with other spellings and readings that count as a hit. */
export const GoldName = z.strictObject({ text: z.string().min(1), alts: z.array(z.string().min(1)).default([]) });
export type GoldName = z.infer<typeof GoldName>;

export const GoldNumber = z.strictObject({
  value: z.number(),
  said: z.string().min(1),
  confusable: z.boolean().optional(), // a teen or tens number that is easy to mishear
});
export type GoldNumber = z.infer<typeof GoldNumber>;

/** A date resolved against the press time, with an optional local clock time. */
export const GoldDate = z.strictObject({
  date: z.string().regex(ISO_DATE),
  time: z.string().regex(CLOCK).optional(),
  said: z.string().min(1),
});
export type GoldDate = z.infer<typeof GoldDate>;

export const Gold = z.strictObject({
  askTo: AskTo,
  heard: z.array(Heard).min(1), // every acceptable value
  say: z.enum(["expected", "absent", "any"]),
  sayLang: SayLang.optional(),
  names: z.array(GoldName),
  numbers: z.array(GoldNumber),
  dates: z.array(GoldDate),
  terms: z.array(GoldName).default([]),
});
export type Gold = z.infer<typeof Gold>;

export const SampleSpec = z.strictObject({
  title: z.string().min(1),
  blurb: z.string().min(1),
  muffleLine: z.number().int().nonnegative(), // the line muffled during playback
  pressAfterLine: z.number().int().nonnegative(), // the button pulses once after this line
  muffle: z.strictObject({ startSec: z.number().nonnegative(), endSec: z.number().positive() }),
  keyMomentSec: z.number().positive(),
});
export type SampleSpec = z.infer<typeof SampleSpec>;

export const EvalClip = z.strictObject({
  id: z.string().regex(KEBAB),
  use: z.enum(CLIP_USES),
  scene: z.string().min(1),
  source: Source,
  meetingLang: CardLang,
  cardLang: CardLang,
  spokenLangs: z.array(SayLang),
  listener: z.array(z.string().min(1)).max(3), // forms people call the listener
  hint: z.string().min(1).optional(),
  pressedAt: z.iso.datetime({ offset: true }).optional(), // overrides referenceTime
  durationSec: z.number().positive().max(LIMITS.maxClipSec),
  effect: z.enum(EFFECTS),
  noise: z.strictObject({ kind: z.enum(NOISE_KINDS), snrDb: z.number() }),
  lines: z.array(ScriptLine),
  sample: SampleSpec.optional(),
  gold: Gold,
});
export type EvalClip = z.infer<typeof EvalClip>;

export const ClipsFile = z
  .strictObject({
    version: z.literal(1),
    about: z.string(),
    referenceTime: z.iso.datetime({ offset: true }), // the press time for relative dates
    tz: z.string().min(1),
    voices: z.record(z.string(), VoiceSpec),
    clips: z.array(EvalClip).min(1),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.clips.forEach((clip, i) => {
      const at = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path: ["clips", i, ...path], message });
      if (seen.has(clip.id)) at(["id"], `duplicate id ${clip.id}`);
      seen.add(clip.id);
      clip.lines.forEach((line, j) => {
        if (!file.voices[line.voice]) at(["lines", j, "voice"], `unknown voice ${line.voice}`);
        for (const [voice] of line.tts ?? []) if (!file.voices[voice]) at(["lines", j, "tts"], `unknown voice ${voice}`);
      });
      if (clip.use === "control" ? clip.lines.length > 0 : clip.lines.length === 0) at(["lines"], "control clips have no lines, the others need some");
      if ((clip.use === "sample") !== (clip.sample !== undefined)) at(["sample"], "sample clips, and only they, carry sample");
      if (clip.sample) {
        const s = clip.sample;
        if (s.muffleLine >= clip.lines.length || s.pressAfterLine >= clip.lines.length) at(["sample"], "line index out of range");
        if (s.muffle.startSec >= s.muffle.endSec || s.muffle.endSec > clip.durationSec) at(["sample", "muffle"], "muffle window outside the clip");
        if (s.keyMomentSec > clip.durationSec) at(["sample", "keyMomentSec"], "key moment after the end");
      }
    });
  });
export type ClipsFile = z.infer<typeof ClipsFile>;

export function loadClipsFile(path: string = CLIPS_PATH): ClipsFile {
  return ClipsFile.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Which clips a run sends. eval is the 10 scripted scenes plus the control clips. */
export const CLIP_SETS = ["eval", "samples", "all"] as const;
export type ClipSet = (typeof CLIP_SETS)[number];

export function clipsInSet(file: ClipsFile, set: ClipSet): EvalClip[] {
  if (set === "all") return [...file.clips];
  if (set === "samples") return file.clips.filter((c) => c.use === "sample");
  return file.clips.filter((c) => c.use === "eval" || c.use === "control");
}

/** The press time of a clip, with the offset kept from the ISO string. */
export function pressTimeOf(file: ClipsFile, clip: EvalClip): { epochMs: number; offsetMinutes: number; iso: string } {
  const iso = clip.pressedAt ?? file.referenceTime;
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  const offsetMinutes = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const epochMs = Date.parse(iso);
  return { epochMs, offsetMinutes, iso: toLocalIso(epochMs, offsetMinutes) };
}

/** The smallest press window that holds the whole clip. */
export function windowFor(seconds: number): WindowSec {
  return WINDOW_SECONDS.find((w) => w >= seconds) ?? 120;
}

/** A mock fixture that fits the clip, so a keyless smoke run exercises every card shape. */
export function mockFixtureFor(clip: EvalClip): MockFixtureKind {
  if (clip.gold.heard.includes("none")) return "no_speech";
  if (clip.spokenLangs.length > 1) return "mixed";
  if (clip.gold.numbers.some((n) => n.confusable)) return "unsure_number";
  return clip.gold.askTo;
}

export interface PressOptions {
  route: RoutePreference;
  sessionId: string;
  sentSec: number;
  cardLang?: CardLang;
  mock?: MockSpec;
  /** The real press time and zone, for runs that save cached cards. Defaults to the script's press time. */
  pressedAt?: string;
  tz?: string;
}

/** PressMeta for one clip, built the way the press pipeline builds it. */
export function pressMetaFor(file: ClipsFile, clip: EvalClip, options: PressOptions): PressMeta {
  const hint = normalizeHint(clip.hint);
  return {
    v: PROTOCOL_VERSION,
    pressedAt: options.pressedAt ?? pressTimeOf(file, clip).iso,
    tz: options.tz ?? file.tz,
    cardLang: options.cardLang ?? clip.cardLang,
    meetingLang: clip.meetingLang,
    windowSec: windowFor(options.sentSec),
    sentSec: Math.round(options.sentSec * 1000) / 1000,
    source: clip.source,
    names: normalizeNames(clip.listener),
    ...(hint ? { hint } : {}),
    route: options.route,
    sessionId: options.sessionId,
    ...(options.route === "mock" && options.mock ? { mock: options.mock } : {}),
  };
}

/** The script as plain lines, for the sample catalog and for reading along. */
export function transcriptOf(clip: EvalClip): { speaker: string; lang: EvalClip["lines"][number]["lang"]; text: string }[] {
  return clip.lines.map((line) => ({ speaker: line.speaker, lang: line.lang, text: line.text }));
}
