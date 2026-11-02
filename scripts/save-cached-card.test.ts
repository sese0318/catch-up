import { describe, expect, it } from "vitest";
import { Card, routeLabelOf } from "@/lib/card/schema";
import type { WireCard } from "@/lib/protocol";
import type { RawRecord } from "../eval/run";
import { buildCachedCard, pickRecord, refusal } from "./save-cached-card";

const wire = (over: Partial<WireCard["meta"]> = {}): WireCard => ({
  heard: "clear",
  ask: { to: "you", text: "木曜日のデモでいいか聞かれました" },
  say: { text: "Just to check, Thursday for the demo?", lang: "en", gloss: "木曜日のデモで確認" },
  summary: ["木曜か月曜のデモについて聞かれました。"],
  facts: [{ kind: "date", text: "11月5日(木)" }],
  meta: { route: "open_weights", model: "meta-models/muse-spark-open-1026", parse: "clean", timing: { totalMs: 2700, bytes: 576_044 }, ...over },
});

const record = (run: number, cardMs: number, card: WireCard | null = wire()): RawRecord => ({
  clipId: "sample-ask-by-name",
  route: "open_weights",
  run,
  cardLang: "ja",
  sentSec: 18,
  bytes: 576_044,
  httpStatus: 200,
  stages: [],
  firstTokenMs: 1200,
  cardMs,
  totalMs: cardMs + 10,
  card,
  error: null,
  failure: null,
  invalidEvents: 0,
  pressedAt: "2026-11-03T14:05:00.000-05:00",
});

// Midday UTC, so the run date is the same on any machine clock.
const raw = { startedAt: "2026-11-03T12:05:00.000Z", route: "open_weights" as const, audio: { dir: "eval/recorded", synthetic: false } };

describe("buildCachedCard", () => {
  it("labels a real run with its live route and run date", () => {
    const card = buildCachedCard(raw, record(1, 2900.4));
    expect(Card.parse(card)).toEqual(card);
    expect(card.meta).toMatchObject({
      route: "cached",
      cachedFrom: "open_weights",
      cachedRunAt: "2026-11-03",
      model: "meta-models/muse-spark-open-1026",
      source: "sample",
      windowSec: 30,
      sentSec: 18,
      cardLang: "ja",
      ms: { total: 2900, firstToken: 1200 },
      sent: { body: "audio", names: true, hint: false },
      pressedAt: "2026-11-03T14:05:00.000-05:00",
    });
    expect(card.meta.cachedBecause).toBeUndefined();
    expect(routeLabelOf(card.meta)).toBe("Saved result from Muse Spark Open");
  });

  it("keeps the backup route and transcript of an Auto run", () => {
    const card = buildCachedCard(
      raw,
      record(1, 6100, wire({ route: "meta_api", model: "muse-voice-transcribe-1.0 + muse-spark-1.3", fallbackFrom: "open_weights", transcript: "Sam, does Thursday work?" })),
    );
    expect(card.meta).toMatchObject({ cachedFrom: "meta_api", fallbackFrom: "open_weights", transcript: "Sam, does Thursday work?" });
  });
});

describe("refusal", () => {
  const ids = ["sample-ask-by-name"];
  it("accepts a real card of a consented public clip", () => {
    expect(refusal(raw, record(1, 2900), ids)).toBeNull();
  });

  it("refuses mock, synthetic audio, clips without consent and Unformatted cards", () => {
    expect(refusal({ ...raw, route: "mock" }, record(1, 2900), ids)).toMatch(/mock/);
    expect(refusal({ ...raw, audio: { dir: "eval/clips", synthetic: true } }, record(1, 2900), ids)).toMatch(/synthetic/);
    expect(refusal(raw, record(1, 2900), [])).toMatch(/written consent/);
    expect(refusal(raw, record(1, 2900, wire({ parse: "unformatted", unformatted: true })), ids)).toMatch(/Unformatted/);
    expect(refusal(raw, record(1, 2900, null), ids)).toMatch(/no card/);
  });
});

describe("pickRecord", () => {
  const records = [record(1, 4000), record(2, 2500), record(3, 3100), record(4, 900, wire({ parse: "unformatted", unformatted: true }))];

  it("takes the median good run, or the run asked for", () => {
    expect(pickRecord(records, "sample-ask-by-name", "ja")?.run).toBe(3);
    expect(pickRecord(records, "sample-ask-by-name", "ja", 1)?.run).toBe(1);
    expect(pickRecord(records, "sample-ask-by-name", "ja", 4)).toBeNull();
    expect(pickRecord(records, "sample-ask-by-name", "en")).toBeNull();
  });
});
