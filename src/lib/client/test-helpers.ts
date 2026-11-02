// Fixtures for the UI lane's tests only. Fictional names. Never imported by app code.
import type { Card, CardMeta } from "../card/schema";

let counter = 0;

export function makeCard(patch: Partial<Omit<Card, "meta">> & { meta?: Partial<CardMeta> } = {}): Card {
  counter += 1;
  const { meta, ...body } = patch;
  return {
    heard: "clear",
    ask: { to: "you", text: "Does Thursday work for the demo, or Monday?", by: "Dana" },
    say: { text: "Just to check, Thursday for the demo, or push to Monday?", lang: "en" },
    summary: ["Dana asked you to pick Thursday or Monday for the demo.", "The team wants to lock the date today."],
    facts: [
      { kind: "date", text: "Thu Nov 5", note: "or Mon Nov 9" },
      { kind: "number", text: "15%", note: "or 50%?", unsure: true },
    ],
    quote: "So Seika, does Thursday work for the demo, or should we push to Monday?",
    ...body,
    meta: {
      id: `card-${counter}`,
      pressedAt: "2026-11-02T10:42:40.123-05:00",
      windowSec: 30,
      sentSec: 30,
      cardLang: "en",
      source: "mic",
      route: "open_weights",
      model: "meta-models/muse-spark-open-1026",
      ms: { total: 2900, firstToken: 2100, upload: 300 },
      bytesSent: 960_044,
      sent: { body: "audio", names: true, hint: false },
      ...meta,
    },
  };
}
