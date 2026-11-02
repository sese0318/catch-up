import { describe, expect, it } from "vitest";
import type { PressEvent } from "../audio/types";
import { ERROR_COPY_EN } from "../protocol";
import {
  INITIAL_CORE,
  announcementFor,
  canReuseClip,
  currentCard,
  isLatestCard,
  sessionReducer,
  type SessionCore,
} from "./session-state";
import { makeCard } from "./test-helpers";

const run = (events: PressEvent[], start: SessionCore = INITIAL_CORE) =>
  events.reduce((state, event) => sessionReducer(state, { type: "press", event }), start);

const pressed = (pressId: string, kind: "new" | "further_back" | "language" | "retry" = "new"): PressEvent => ({
  type: "pressed",
  pressId,
  kind,
  pressedAt: 1_000,
  stall: { text: "Let me think about that for a second.", lang: "en" },
});

describe("session reducer", () => {
  it("walks a press from the stall line to the card", () => {
    const card = makeCard();
    let s = run([pressed("p1")]);
    expect(s.request).toMatchObject({ phase: "busy", step: "capturing", stall: { lang: "en" } });
    s = run([{ type: "sending", pressId: "p1", windowSec: 30, sentSec: 12, bytes: 384_044, partial: true }], s);
    expect(s.request).toMatchObject({ step: "sending", sentSec: 12, partial: true });
    s = run([{ type: "stage", pressId: "p1", name: "received", elapsedMs: 400 }], s);
    s = run([{ type: "stage", pressId: "p1", name: "fallback", elapsedMs: 8_100 }], s);
    s = run([{ type: "still_working", pressId: "p1", elapsedMs: 6_000 }], s);
    expect(s.request).toMatchObject({ step: "fallback", fallback: true, stillWorking: true });
    s = run([{ type: "card", pressId: "p1", card, replaces: null, server: null }], s);
    expect(s.request).toEqual({ phase: "idle" });
    expect(currentCard(s)?.meta.id).toBe(card.meta.id);
    expect(s.unexported).toBe(true);
    expect(s.announcement).toMatchObject({ assertive: true, seq: 1 });
  });

  it("keeps history newest first and replaces a card on Further back", () => {
    const a = makeCard();
    const b = makeCard();
    let s = run([
      pressed("p1"),
      { type: "card", pressId: "p1", card: a, replaces: null, server: null },
      pressed("p2"),
    ]);
    expect(s.currentId).toBeNull(); // a new press clears the card area
    s = run([{ type: "card", pressId: "p2", card: b, replaces: null, server: null }], s);
    expect(s.cards.map((c) => c.meta.id)).toEqual([b.meta.id, a.meta.id]);

    const wider = makeCard({ meta: { windowSec: 60, sentSec: 60 } });
    s = run([pressed("p3", "further_back")], s);
    expect(s.currentId).toBe(b.meta.id); // the card stays while it is redone
    s = run([{ type: "card", pressId: "p3", card: wider, replaces: b.meta.id, server: null }], s);
    expect(s.cards.map((c) => c.meta.id)).toEqual([wider.meta.id, a.meta.id]);
    expect(isLatestCard(s, wider)).toBe(true);
    expect(isLatestCard(s, a)).toBe(false);
  });

  it("shows silent, error and cancelled for the right press only", () => {
    let s = run([pressed("p1"), { type: "silent", pressId: "p1", windowSec: 30, sentSec: 30 }]);
    expect(s.request).toMatchObject({ phase: "silent", windowSec: 30 });

    s = run([pressed("p2"), { type: "error", pressId: "old", code: "timeout", retryable: true, sent: true }], s);
    expect(s.request.phase).toBe("busy");
    s = run([{ type: "error", pressId: "p2", code: "timeout", retryable: true, sent: true, route: "open_weights" }], s);
    expect(s.request).toMatchObject({ phase: "error", code: "timeout", sent: true, kind: "new" });
    expect(s.announcement?.parts[0].text).toBe(ERROR_COPY_EN.timeout);

    s = run([pressed("p3"), { type: "cancelled", pressId: "p3", sent: false }], s);
    expect(s.request).toMatchObject({ phase: "cancelled", sent: false });
  });

  it("closes the card into history, clears, and tracks exports", () => {
    const card = makeCard();
    let s = run([pressed("p1"), { type: "card", pressId: "p1", card, replaces: null, server: null }]);
    s = sessionReducer(s, { type: "close_card" });
    expect(s.currentId).toBeNull();
    expect(s.cards).toHaveLength(1);
    s = sessionReducer(s, { type: "exported" });
    expect(s.unexported).toBe(false);
    s = sessionReducer(s, { type: "clear_history" });
    expect(s.cards).toHaveLength(0);
  });

  it("holds the clip until the pipeline zeroes it", () => {
    let s = run([{ type: "held", until: 5_000 }]);
    expect(canReuseClip(s, 4_000)).toBe(true);
    expect(canReuseClip(s, 6_000)).toBe(false);
    s = run([{ type: "held", until: null }], s);
    expect(canReuseClip(s, 0)).toBe(false);
  });
});

describe("live region text", () => {
  it("speaks ask then the line to say, assertive only when asked", () => {
    const you = announcementFor(makeCard(), 1);
    expect(you.assertive).toBe(true);
    expect(you.parts.map((p) => p.text)).toEqual([
      "Asked you.",
      "Does Thursday work for the demo, or Monday?",
      "To check, say.",
      "Just to check, Thursday for the demo, or push to Monday?",
    ]);
    const room = announcementFor(makeCard({ ask: { to: "room", text: "Who takes notes?" } }), 2);
    expect(room.assertive).toBe(false);
    const none = announcementFor(makeCard({ ask: { to: "none" } }), 3);
    expect(none.parts[0].text).toBe("Nothing asked of you.");
    expect(none.parts[2].text).toBe("To jump back in.");
    const quiet = announcementFor(makeCard({ heard: "none", ask: { to: "none" }, say: undefined, facts: [] }), 4);
    expect(quiet.parts).toEqual([{ lang: "en", text: "Couldn't make out any speech." }]);
  });

  it("tags each part with its language", () => {
    const ja = announcementFor(
      makeCard({
        say: { text: "Just to check, Thursday?", lang: "en", gloss: "木曜日で大丈夫か確認" },
        meta: { cardLang: "ja" },
      }),
      1,
    );
    expect(ja.parts[0].lang).toBe("ja");
    expect(ja.parts[3].lang).toBe("en");
    const zh = announcementFor(makeCard({ meta: { cardLang: "zh" } }), 2);
    expect(zh.parts[0].lang).toBe("zh-Hans");
  });
});
