// Server-side card parsing (ux-spec 2-5). Card lane. Pure, no I/O, never logs model text.
import type { CardBody, CardLang } from "./schema";

/** Built by the server from the decoded PressMeta. */
export interface ClampContext {
  cardLang: CardLang;
  meetingLang: CardLang; // the language of the repeat line filled in when heard is poor
}

export type ParseOutcome =
  | { ok: true; body: CardBody; quality: "clean" | "clamped" }
  | { ok: false; reason: "empty" | "no_json" | "bad_json" | "not_card" };

/** Removes <|...|> control tokens, stray to= headers and code fences, then trims. */
export function stripModelText(raw: string): string {
  void raw;
  throw new Error("not implemented");
}

/** The text between the first "{" and the last "}", or null when there is none. */
export function extractJsonObject(text: string): string | null {
  void text;
  throw new Error("not implemented");
}

/**
 * Turns any parsed JSON into a valid CardBody by clamping instead of rejecting.
 * Unknown enums fall to safe values (ask.to none, heard partial, kind term), strings are clipped
 * to CAPS with clipToWidth, facts cut to 5, summary to 2, false booleans dropped, gloss dropped
 * when say.lang equals ctx.cardLang, a missing ask.text is taken from the quote (or ask.to falls
 * to none), and heard none forces ask.to none, no say, no facts and one summary sentence. heard
 * poor with no say gets the repeat line, say { text: repeatLine(ctx.meetingLang), lang:
 * ctx.meetingLang } plus gloss repeatLine(ctx.cardLang) when the two languages differ. quality is
 * "clean" when nothing had to change. Returns null only when no summary text can be found at all.
 */
export function clampCardBody(
  input: unknown,
  ctx: ClampContext,
): { body: CardBody; quality: "clean" | "clamped" } | null {
  void input;
  void ctx;
  throw new Error("not implemented");
}

/**
 * Teen and tens backstop. When say.lang is en or the quote reads as English, a number fact that
 * holds 13 to 19 or a round 30 to 90 gets unsure and the paired reading in note (15 and 50,
 * 13 and 30) unless the model already did it.
 */
export function applyNumberBackstop(body: CardBody): CardBody {
  void body;
  throw new Error("not implemented");
}

/** stripModelText, extractJsonObject, JSON.parse, clampCardBody, then applyNumberBackstop. */
export function parseCardText(raw: string, ctx: ClampContext): ParseOutcome {
  void raw;
  void ctx;
  throw new Error("not implemented");
}

/**
 * The Unformatted card body. heard partial, ask.to none, no say, no facts, and the cleaned raw
 * text (at most UNFORMATTED_MAX_CHARS) in summary[0]. The server sets meta.unformatted.
 */
export function unformattedBody(raw: string, ctx: ClampContext): CardBody {
  void raw;
  void ctx;
  throw new Error("not implemented");
}
