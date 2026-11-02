// Local strings in the card language (ux-spec 2-7 and 5). Card lane. Never from the model.
// App chrome (buttons, settings, states) stays English and lives in the UI lane.
import type { CardLang, WindowSec } from "./schema";

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

/** The ux-spec 2-7 table, exactly as written there, for en, ja and zh. */
export function localString(lang: CardLang, key: LocalStringKey): string {
  void lang;
  void key;
  throw new Error("not implemented");
}

/** Shown at press time in the meeting language. */
export function stallLine(lang: CardLang): string {
  void lang;
  throw new Error("not implemented");
}

/** The polite repeat request used when heard is poor. */
export function repeatLine(lang: CardLang): string {
  void lang;
  throw new Error("not implemented");
}

/** The heads-up line from ux-spec 5 with the window seconds filled in. */
export function headsUpLine(lang: CardLang, windowSec: WindowSec): string {
  void lang;
  void windowSec;
  throw new Error("not implemented");
}
