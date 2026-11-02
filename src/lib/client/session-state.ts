// What the panel shows for presses and cards, as a pure reducer over press pipeline events
// (src/lib/audio/types.ts PressEvent) plus a few UI actions. History lives here, in memory only.
import type { LiveRoute, WindowSec, Card, CardLang } from "../card/schema";
import type { PressEvent, PressKind } from "../audio/types";
import { ERROR_COPY_EN, type ErrorCode, type ProviderFailure, type StageName } from "../protocol";
import { label } from "./local";

export type BusyStep = "capturing" | "sending" | StageName;

export type RequestView =
  | { phase: "idle" }
  | {
      phase: "busy";
      pressId: string;
      kind: PressKind;
      pressedAt: number;
      stall: { text: string; lang: CardLang };
      step: BusyStep;
      windowSec: WindowSec | null;
      sentSec: number | null;
      bytes: number | null;
      partial: boolean;
      stillWorking: boolean;
      fallback: boolean;
    }
  | { phase: "silent"; pressId: string; windowSec: WindowSec; sentSec: number }
  | {
      phase: "error";
      pressId: string;
      kind: PressKind;
      code: ErrorCode;
      retryable: boolean;
      sent: boolean;
      route?: LiveRoute;
      cause?: ProviderFailure;
      retryAfterSec?: number;
    }
  | { phase: "cancelled"; pressId: string; kind: PressKind; sent: boolean };

export interface AnnouncePart {
  lang: string; // BCP 47 tag or card language code
  text: string;
}

export interface Announcement {
  seq: number;
  assertive: boolean;
  parts: readonly AnnouncePart[];
}

export interface SessionCore {
  request: RequestView;
  /** Newest first, in memory only. */
  cards: readonly Card[];
  /** The card in the card area, or null when it was closed into history. */
  currentId: string | null;
  /** The press snapshot can be reused for Further back and language until then. */
  heldUntil: number | null;
  /** True when cards changed since the last export. Drives the leave warning. */
  unexported: boolean;
  announcement: Announcement | null;
  seq: number;
}

export type SessionAction =
  | { type: "press"; event: PressEvent }
  | { type: "close_card" }
  | { type: "clear_history" }
  | { type: "exported" }
  | { type: "dismiss_request" };

export const INITIAL_CORE: SessionCore = {
  request: { phase: "idle" },
  cards: [],
  currentId: null,
  heldUntil: null,
  unexported: false,
  announcement: null,
  seq: 0,
};

function zhTag(lang: string): string {
  return lang === "zh" ? "zh-Hans" : lang === "other" ? "und" : lang;
}

/** What the live region says once a card is complete (ux-spec 6 item 5). */
export function announcementFor(card: Card, seq: number): Announcement {
  const lang = card.meta.cardLang;
  const tag = zhTag(lang);
  const parts: AnnouncePart[] = [];
  if (card.heard === "none") {
    parts.push({ lang: tag, text: `${label(lang, "noSpeech")}.` });
    return { seq, assertive: false, parts };
  }
  const askKey = card.ask.to === "you" ? "askedYou" : card.ask.to === "room" ? "room" : card.ask.to === "mentioned" ? "mentioned" : "none";
  parts.push({ lang: tag, text: `${label(lang, askKey)}.` });
  const detail = card.ask.to === "none" ? card.summary[0] : (card.ask.text ?? card.summary[0]);
  if (detail) parts.push({ lang: tag, text: detail });
  if (card.say) {
    parts.push({ lang: tag, text: `${label(lang, card.ask.to === "none" ? "sayNone" : "sayAsked")}.` });
    parts.push({ lang: zhTag(card.say.lang), text: card.say.text });
  }
  return { seq, assertive: card.ask.to === "you", parts };
}

function errorAnnouncement(code: ErrorCode, seq: number): Announcement {
  return { seq, assertive: false, parts: [{ lang: "en", text: ERROR_COPY_EN[code] }] };
}

function upsertCard(cards: readonly Card[], card: Card, replaces: string | null): Card[] {
  if (replaces) {
    const index = cards.findIndex((c) => c.meta.id === replaces);
    if (index >= 0) {
      const next = [...cards];
      next[index] = card;
      return next;
    }
  }
  return [card, ...cards.filter((c) => c.meta.id !== card.meta.id)];
}

function samePress(request: RequestView, pressId: string): boolean {
  return request.phase !== "idle" && request.pressId === pressId;
}

export function sessionReducer(state: SessionCore, action: SessionAction): SessionCore {
  switch (action.type) {
    case "close_card":
      return { ...state, currentId: null, request: state.request.phase === "busy" ? state.request : { phase: "idle" } };
    case "clear_history":
      return { ...state, cards: [], currentId: null, unexported: false, request: state.request.phase === "busy" ? state.request : { phase: "idle" } };
    case "exported":
      return { ...state, unexported: false };
    case "dismiss_request":
      return state.request.phase === "busy" ? state : { ...state, request: { phase: "idle" } };
    case "press":
      return reducePressEvent(state, action.event);
  }
}

function reducePressEvent(state: SessionCore, ev: PressEvent): SessionCore {
  switch (ev.type) {
    case "pressed":
      return {
        ...state,
        // A new press clears the card area. Further back, language and retries keep the card they replace.
        currentId: ev.kind === "new" ? null : state.currentId,
        request: {
          phase: "busy",
          pressId: ev.pressId,
          kind: ev.kind,
          pressedAt: ev.pressedAt,
          stall: ev.stall,
          step: "capturing",
          windowSec: null,
          sentSec: null,
          bytes: null,
          partial: false,
          stillWorking: false,
          fallback: false,
        },
      };
    case "sending":
      if (state.request.phase !== "busy" || state.request.pressId !== ev.pressId) return state;
      return {
        ...state,
        request: { ...state.request, step: "sending", windowSec: ev.windowSec, sentSec: ev.sentSec, bytes: ev.bytes, partial: ev.partial },
      };
    case "stage":
      if (state.request.phase !== "busy" || state.request.pressId !== ev.pressId) return state;
      return {
        ...state,
        request: { ...state.request, step: ev.name, fallback: state.request.fallback || ev.name === "fallback" },
      };
    case "still_working":
      if (state.request.phase !== "busy" || state.request.pressId !== ev.pressId) return state;
      return { ...state, request: { ...state.request, stillWorking: true } };
    case "silent":
      if (!samePress(state.request, ev.pressId)) return state;
      return { ...state, request: { phase: "silent", pressId: ev.pressId, windowSec: ev.windowSec, sentSec: ev.sentSec } };
    case "card": {
      const seq = state.seq + 1;
      return {
        ...state,
        seq,
        cards: upsertCard(state.cards, ev.card, ev.replaces),
        currentId: ev.card.meta.id,
        request: { phase: "idle" },
        unexported: true,
        announcement: announcementFor(ev.card, seq),
      };
    }
    case "error": {
      if (!samePress(state.request, ev.pressId)) return state;
      const kind = state.request.phase === "busy" ? state.request.kind : "new";
      const seq = state.seq + 1;
      return {
        ...state,
        seq,
        announcement: errorAnnouncement(ev.code, seq),
        request: {
          phase: "error",
          pressId: ev.pressId,
          kind,
          code: ev.code,
          retryable: ev.retryable,
          sent: ev.sent,
          route: ev.route,
          cause: ev.cause,
          retryAfterSec: ev.retryAfterSec,
        },
      };
    }
    case "cancelled": {
      if (!samePress(state.request, ev.pressId)) return state;
      const kind = state.request.phase === "busy" ? state.request.kind : "new";
      return { ...state, request: { phase: "cancelled", pressId: ev.pressId, kind, sent: ev.sent } };
    }
    case "held":
      return { ...state, heldUntil: ev.until };
  }
}

/** The card in the card area. */
export function currentCard(core: SessionCore): Card | null {
  if (!core.currentId) return null;
  return core.cards.find((c) => c.meta.id === core.currentId) ?? null;
}

/** True when Further back and language redo can reuse the press snapshot. */
export function canReuseClip(core: SessionCore, now: number): boolean {
  return core.heldUntil !== null && core.heldUntil > now;
}

/** The card Further back and the language chips act on, the newest one, only while it is shown. */
export function isLatestCard(core: SessionCore, card: Card): boolean {
  return core.cards.length > 0 && core.cards[0].meta.id === card.meta.id;
}
