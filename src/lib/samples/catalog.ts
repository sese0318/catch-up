// Sample conversations for the landing page and the sample flow (ux-spec 3 and 9 item 6).
// Eval lane. Public clips need written consent. Synthetic test clips live in public/samples/dev
// (git-ignored, never shipped) and are listed only outside production.
// Browser safe. The press pipeline and the UI import this file, so it never imports fs, path,
// node: modules or server code, and it never lists a folder at run time.
import type { MuffleWindow } from "../audio/types";
import type { Card, CardLang, SayLang } from "../card/schema";

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
}

/** Public clips with written consent. Filled by the eval lane. */
export const SAMPLE_CLIPS: readonly SampleClip[] = [];

/**
 * Synthetic dev clips, a static list written to match eval/clips.json, with fixed file names under
 * /samples/dev/ that scripts/make-synthetic-clips.ps1 creates. consent "synthetic", never cached.
 */
export const DEV_SAMPLE_CLIPS: readonly SampleClip[] = [];

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
