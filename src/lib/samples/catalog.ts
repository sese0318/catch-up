// Sample conversations for the landing page and the sample flow (ux-spec 3 and 9 item 6).
// Eval lane. Public clips need written consent. Synthetic test clips live in public/samples/dev
// (git-ignored, never shipped) and are listed only outside production.
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
  /** Saved real results, meta.route "cached" with meta.cachedRunAt. Empty until gate 1. */
  cached: Partial<Record<CardLang, Card>>;
}

/** Public clips with written consent. Filled by the eval lane. */
export const SAMPLE_CLIPS: readonly SampleClip[] = [];

/** What the sample strip shows. Adds synthetic dev clips outside production. */
export function listSampleClips(): readonly SampleClip[] {
  return SAMPLE_CLIPS;
}

export function getSampleClip(id: string): SampleClip | null {
  return listSampleClips().find((clip) => clip.id === id) ?? null;
}

/** The saved real card for a clip in a card language, or null. */
export function getCachedCard(id: string, lang: CardLang): Card | null {
  return getSampleClip(id)?.cached[lang] ?? null;
}
