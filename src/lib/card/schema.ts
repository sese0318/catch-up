// Catch Up card v1 (ux-spec 2-1). One type for the whole card.
// The model writes CardBody. The app (server and client) writes meta.
// Caps are width units. CJK and full-width characters count 2, everything else 1,
// so 80 units is 80 Latin characters or 40 Japanese or Chinese characters.
// Over-cap text is clipped by the card module (clipToWidth), never rejected,
// so these zod schemas check structure and enums only.
import { z } from "zod";

export const CARD_LANGS = ["en", "ja", "zh"] as const; // zh means Simplified Chinese (zh-Hans)
export const HEARD_VALUES = ["clear", "partial", "poor", "none"] as const;
export const ASK_TO_VALUES = ["you", "room", "mentioned", "none"] as const;
export const SAY_LANGS = ["en", "ja", "zh", "other"] as const;
export const FACT_KINDS = ["name", "date", "number", "place", "term", "task"] as const;
export const WINDOW_SECONDS = [30, 60, 120] as const;
export const SOURCES = ["mic", "tab", "system", "sample"] as const;
export const CARD_ROUTES = ["open_weights", "meta_api", "cached", "mock"] as const;
export const LIVE_ROUTES = ["open_weights", "meta_api"] as const;

export const CardLang = z.enum(CARD_LANGS);
export type CardLang = z.infer<typeof CardLang>;
export const Heard = z.enum(HEARD_VALUES);
export type Heard = z.infer<typeof Heard>;
export const AskTo = z.enum(ASK_TO_VALUES);
export type AskTo = z.infer<typeof AskTo>;
export const SayLang = z.enum(SAY_LANGS);
export type SayLang = z.infer<typeof SayLang>;
export const FactKind = z.enum(FACT_KINDS);
export type FactKind = z.infer<typeof FactKind>;
export const WindowSec = z.union([z.literal(30), z.literal(60), z.literal(120)]);
export type WindowSec = z.infer<typeof WindowSec>;
export const Source = z.enum(SOURCES);
export type Source = z.infer<typeof Source>;
export const CardRoute = z.enum(CARD_ROUTES);
export type CardRoute = z.infer<typeof CardRoute>;
export const LiveRoute = z.enum(LIVE_ROUTES);
export type LiveRoute = z.infer<typeof LiveRoute>;

/** Width caps in width units. */
export const CAPS = {
  askText: 90,
  askBy: 30,
  sayText: 110,
  sayGloss: 110,
  summaryGlance: 80, // summary[0]
  summaryContext: 140, // summary[1]
  factText: 40,
  factNote: 40,
  quote: 160,
  listenerNames: 60, // all name forms joined with ", "
  sessionHint: 120,
} as const;
export const MAX_FACTS = 5;
export const MAX_SUMMARY = 2;
/** Raw model text kept in summary[0] of an Unformatted card (characters, not width units). */
export const UNFORMATTED_MAX_CHARS = 2000;

/** Keys in the order the model is asked to write them. */
export const CARD_KEY_ORDER = ["heard", "ask", "say", "summary", "facts", "quote", "earlier"] as const;

export const Ask = z.object({
  to: AskTo, // "you" only if a listener name was used, or a direct question in a clear two-person talk
  text: z.string().optional(), // required unless to is "none" (clampCardBody enforces it). Card language. Max 90
  by: z.string().optional(), // only if a name or role was said, as spoken. Max 30
});
export type Ask = z.infer<typeof Ask>;

export const Say = z.object({
  text: z.string(), // one line to say out loud now, in the language the speaker used. Restates or confirms, never answers. Max 110
  lang: SayLang,
  gloss: z.string().optional(), // meaning in card language, only when lang differs from it. Max 110
});
export type Say = z.infer<typeof Say>;

export const Fact = z.object({
  kind: FactKind, // name covers people and organizations
  text: z.string(), // names, places and terms as spoken. Dates and numbers normalized in card language. Max 40
  note: z.string().optional(), // card language. Resolved date, reading, meaning, or the other possible reading. Max 40
  unsure: z.literal(true).optional(), // might be misheard. Dotted underline and the word Check
});
export type Fact = z.infer<typeof Fact>;

/** [0] is the glance line (max 80), [1] adds context (max 140). */
export const Summary = z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]);
export type Summary = z.infer<typeof Summary>;

/** What the model writes. Unknown keys are stripped. */
export const CardBody = z.object({
  heard: Heard,
  ask: Ask,
  say: Say.optional(), // left out only when heard is "none" or the clip is clearly a recording or video
  summary: Summary,
  facts: z.array(Fact).max(MAX_FACTS), // 0 to 5, most useful first, never invented
  quote: z.string().optional(), // the key sentence verbatim in the language spoken. Max 160
  earlier: z.literal(true).optional(), // the clip starts mid-thought. The UI promotes Further back
});
export type CardBody = z.infer<typeof CardBody>;

export const CardTimings = z.object({
  total: z.number().nonnegative(), // press to card on screen
  firstToken: z.number().nonnegative().optional(), // press to first answer token (the writing stage)
  upload: z.number().nonnegative().optional(), // request start to the received stage
});
export type CardTimings = z.infer<typeof CardTimings>;

/** Written by the app, never by the model. */
export const CardMeta = z.object({
  id: z.string().min(1),
  pressedAt: z.string().min(1), // ISO time of the keydown, pointerdown or hotkey event
  windowSec: WindowSec,
  sentSec: z.number().nonnegative(), // less than windowSec when memory was not full yet
  cardLang: CardLang,
  source: Source,
  route: CardRoute,
  model: z.string(), // "meta-models/muse-spark-open-1026", or "muse-voice-transcribe-1.0 + muse-spark-1.3"
  fallbackFrom: z.literal("open_weights").optional(),
  ms: CardTimings,
  bytesSent: z.number().int().nonnegative(),
  transcript: z.string().optional(), // Route A only, shown under What they said
  cachedRunAt: z.string().optional(), // set when route is "cached", the date of the real run it came from
  unformatted: z.literal(true).optional(), // JSON never parsed, the raw text sits in summary[0]
});
export type CardMeta = z.infer<typeof CardMeta>;

export const Card = CardBody.extend({ meta: CardMeta });
export type Card = z.infer<typeof Card>;

/** Receipt and footer names for each route. App chrome, English only. */
export const ROUTE_LABELS: Record<CardRoute, string> = {
  open_weights: "Muse Spark Open on Baseten",
  meta_api: "Muse Voice Transcribe and Muse Spark on Meta Model API",
  cached: "Saved result from Muse Spark Open",
  mock: "Sample card, no model was called",
};

/** Route A model label as it appears in meta.model. */
export function routeAModelLabel(asrModel: string, cardModel: string): string {
  return `${asrModel} + ${cardModel}`;
}

// Width units. East Asian Wide and Fullwidth code points count 2, combining marks,
// variation selectors and zero-width characters count 0, everything else 1.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // kana, Bopomofo, Hangul compatibility, CJK strokes, enclosed and compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth ASCII and punctuation
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1faff], // emoji and pictographs
  [0x20000, 0x3fffd], // CJK extensions B and later
];
const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritics
  [0x200b, 0x200f], // zero-width space, joiners, marks
  [0xfe00, 0xfe0f], // variation selectors
  [0xe0100, 0xe01ef], // variation selectors supplement
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

/** Width of one code point in width units (0, 1 or 2). */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (inRanges(cp, ZERO_RANGES)) return 0;
  return inRanges(cp, WIDE_RANGES) ? 2 : 1;
}

/** Width of a string in width units. CJK and full-width characters count 2. */
export function widthOf(text: string): number {
  let w = 0;
  for (const ch of text) w += codePointWidth(ch.codePointAt(0) ?? 0);
  return w;
}

// JSON Schema of CardBody for Meta Model API response_format (constrained decoding).
// Hand-written so the key order, enums and descriptions are exact. No $ref, no recursion,
// no oneOf or allOf, every object closed. Width caps live in descriptions, not maxLength,
// because maxLength counts characters and would cut text mid-word.
export const CARD_JSON_SCHEMA_NAME = "CatchUpCard";

export const CARD_BODY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    heard: {
      type: "string",
      enum: [...HEARD_VALUES],
      description: "How well speech came through. none means no usable speech (silence, music, noise).",
    },
    ask: {
      type: "object",
      additionalProperties: false,
      properties: {
        to: {
          type: "string",
          enum: [...ASK_TO_VALUES],
          description:
            "you only if a listener name was used, or a direct question in a clear two-person talk. mentioned when the listener is named without a question. room for an open question to everyone.",
        },
        text: {
          type: "string",
          description: "The question, request or mention, in the card language. Required unless to is none. Max 90 width units.",
        },
        by: { type: "string", description: "Only if a name or role was said, as spoken. Max 30 width units." },
      },
      required: ["to"],
    },
    say: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          description:
            "One line to say out loud now, in the language the speaker used. Restates or confirms, never answers. Max 110 width units.",
        },
        lang: { type: "string", enum: [...SAY_LANGS], description: "Language of say.text." },
        gloss: {
          type: "string",
          description: "Meaning of say.text in the card language, only when lang differs from it. Max 110 width units.",
        },
      },
      required: ["text", "lang"],
    },
    summary: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: MAX_SUMMARY,
      description: "Card language. Item 0 is the glance line (max 80 width units), item 1 adds context (max 140).",
    },
    facts: {
      type: "array",
      maxItems: MAX_FACTS,
      description: "0 to 5 facts, most useful first, never invented.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: [...FACT_KINDS] },
          text: {
            type: "string",
            description:
              "Names, places and terms as spoken in their own script. Dates and numbers normalized in the card language. Max 40 width units.",
          },
          note: {
            type: "string",
            description:
              "Card language. Resolved date, reading of a name, meaning of a term, or the other possible reading when unsure. Max 40 width units.",
          },
          unsure: { type: "boolean", description: "true only when this might be misheard. Leave it out otherwise." },
        },
        required: ["kind", "text"],
      },
    },
    quote: {
      type: "string",
      description: "The key sentence verbatim in the language spoken, the evidence for ask and say. Max 160 width units.",
    },
    earlier: { type: "boolean", description: "true only when the clip starts mid-thought. Leave it out otherwise." },
  },
  required: ["heard", "ask", "summary", "facts"],
} as const;

/** response_format for Meta Model API Chat Completions. strict false keeps optional keys optional. */
export const META_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: CARD_JSON_SCHEMA_NAME, schema: CARD_BODY_JSON_SCHEMA, strict: false },
} as const;
