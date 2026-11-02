// Saves a real eval result for a public sample clip as its cached card, the one the press pipeline
// shows when live calls fail, are capped or are off. Refuses mock runs, synthetic audio, Unformatted
// cards and clips without written consent, so a cached card is always a real run of a consented clip.
//   npx tsx scripts/save-cached-card.ts --raw eval/results/raw/<file>.json --clip <id> --lang ja [--run 2]
// Without --run it takes the run whose full card time is the median of that clip's good cards.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CARD_LANGS, Card, type CardLang } from "@/lib/card/schema";
import { toLocalIso } from "@/lib/protocol";
import { SAMPLE_CLIPS } from "@/lib/samples/catalog";
import { windowFor } from "../eval/clips";
import type { RawRecord, RawRun } from "../eval/run";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const CACHED_CARDS_PATH = resolve(ROOT, "src/lib/samples/cached-cards.json");

export type CachedCards = Record<string, Partial<Record<CardLang, Card>>>;

/** Why a raw record cannot become a cached card, or null when it can. */
export function refusal(raw: Pick<RawRun, "route" | "audio">, record: RawRecord, publicIds: readonly string[]): string | null {
  if (raw.route === "mock") return "mock runs never become cached cards";
  if (raw.audio.synthetic) return "synthetic audio never becomes a cached card, record the consented clip first";
  if (!publicIds.includes(record.clipId)) return `${record.clipId} is not a public clip with written consent`;
  const card = record.card;
  if (!card) return "that run has no card";
  if (card.meta.route === "mock") return "mock cards never become cached cards";
  if (card.meta.parse === "unformatted" || card.meta.unformatted) return "Unformatted cards are not saved";
  if (record.cardMs === null) return "that run has no card time";
  return null;
}

/** A full Card for the catalog, labeled with the live route and the date of the saved run. */
export function buildCachedCard(raw: Pick<RawRun, "startedAt">, record: RawRecord): Card {
  if (!record.card) throw new Error("needs a card");
  const { meta: server, ...body } = record.card;
  const cachedFrom = server.route;
  if (cachedFrom === "mock") throw new Error("needs a live card");
  const card: Card = {
    ...body,
    meta: {
      id: `cached-${record.clipId}-${record.cardLang}`,
      pressedAt: record.pressedAt ?? raw.startedAt,
      windowSec: windowFor(record.sentSec),
      sentSec: record.sentSec,
      cardLang: record.cardLang,
      source: "sample",
      route: "cached",
      model: server.model,
      ...(server.fallbackFrom ? { fallbackFrom: server.fallbackFrom } : {}),
      ms: {
        total: Math.round(record.cardMs ?? server.timing.totalMs),
        ...(record.firstTokenMs !== null ? { firstToken: Math.round(record.firstTokenMs) } : {}),
      },
      bytesSent: record.bytes,
      sent: { body: "audio", names: true, hint: false },
      ...(server.transcript !== undefined ? { transcript: server.transcript } : {}),
      cachedFrom,
      cachedRunAt: toLocalIso(Date.parse(raw.startedAt)).slice(0, 10), // the run's date on this machine's clock
    },
  };
  return Card.parse(card);
}

/** The run to keep, the median full card time among the clip's good runs in that language. */
export function pickRecord(records: readonly RawRecord[], clipId: string, lang: CardLang, run?: number): RawRecord | null {
  const mine = records.filter((r) => r.clipId === clipId && r.cardLang === lang && r.card && r.card.meta.parse !== "unformatted");
  if (run !== undefined) return mine.find((r) => r.run === run) ?? null;
  const sorted = [...mine].sort((a, b) => (a.cardMs ?? 0) - (b.cardMs ?? 0));
  return sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)];
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { raw: { type: "string" }, clip: { type: "string" }, lang: { type: "string" }, run: { type: "string" } },
    strict: true,
  });
  if (!values.raw || !values.clip || !values.lang) {
    console.error("Pass --raw FILE --clip ID --lang en, ja or zh, and optionally --run N.");
    return 1;
  }
  const lang = values.lang as CardLang;
  if (!CARD_LANGS.includes(lang)) {
    console.error(`--lang takes ${CARD_LANGS.join(", ")}.`);
    return 1;
  }
  const raw = JSON.parse(readFileSync(resolve(ROOT, values.raw), "utf8")) as RawRun;
  if (raw.kind !== "catchup-eval-raw") {
    console.error("That file is not a raw eval result.");
    return 1;
  }
  const record = pickRecord(raw.records, values.clip, lang, values.run ? Number(values.run) : undefined);
  if (!record) {
    console.error(`No good card for ${values.clip} in ${lang} in that file.`);
    return 1;
  }
  const why = refusal(raw, record, SAMPLE_CLIPS.map((c) => c.id));
  if (why) {
    console.error(`Not saved, ${why}.`);
    return 1;
  }
  const card = buildCachedCard(raw, record);
  const saved = JSON.parse(readFileSync(CACHED_CARDS_PATH, "utf8")) as CachedCards;
  saved[record.clipId] = { ...saved[record.clipId], [lang]: card };
  writeFileSync(CACHED_CARDS_PATH, `${JSON.stringify(saved, null, 2)}\n`);
  console.log(
    `Saved the ${lang} card for ${record.clipId} from run ${record.run} (${card.meta.cachedFrom}, ${card.meta.model}, ${(card.meta.ms.total / 1000).toFixed(1)} s).`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
