import { describe, expect, it } from "vitest";
import { selectSummaryRuns, summaryStem, type RawRun, type RawRunFile } from "./run";

function entry(route: RawRun["route"], at: number, changes: Partial<RawRun> = {}): RawRunFile {
  return {
    file: `${at}-${route}.json`,
    raw: {
      kind: "catchup-eval-raw",
      version: 1,
      startedAt: `2026-11-03T10:${String(at).padStart(2, "0")}:00.000Z`,
      finishedAt: `2026-11-03T10:${String(at).padStart(2, "0")}:30.000Z`,
      route,
      mode: "in_process",
      pressTime: "script",
      runs: 3,
      set: "eval",
      clipIds: ["ask-by-name", "silence"],
      cardLang: null,
      audio: { dir: "eval/clips", synthetic: true },
      models: { open_weights: "main", meta_api: "backup" },
      clipsSha256: "scripts-v1",
      records: [],
      ...changes,
    },
  };
}

describe("summary datasets", () => {
  it("keeps a later sample/cache run out of the benchmark and saves it separately", () => {
    const main = entry("open_weights", 1);
    const backup = entry("meta_api", 2);
    const sample = entry("open_weights", 3, {
      set: "samples", pressTime: "now", clipIds: ["sample-office-hours"],
      audio: { dir: "eval/recorded", synthetic: false },
    });
    expect(selectSummaryRuns([main, backup, sample], "eval", "script")).toEqual([main, backup]);
    expect(selectSummaryRuns([main, backup, sample], "samples", "now")).toEqual([sample]);
    expect(summaryStem("eval", "script")).toBe("summary");
    expect(summaryStem("samples", "now")).toBe("samples-now-summary");
  });

  it("does not compare a partial or different-language run with the old full dataset", () => {
    const full = entry("meta_api", 1);
    const partial = entry("open_weights", 2, { clipIds: ["ask-by-name"], cardLang: "ja" });
    expect(selectSummaryRuns([full, partial], "eval", "script")).toEqual([partial]);
    const matching = entry("meta_api", 3, { clipIds: ["ask-by-name"], cardLang: "ja" });
    expect(selectSummaryRuns([full, partial, matching], "eval", "script")).toEqual([partial, matching]);
  });

  it("keeps different recordings, script versions and run counts out of a comparison", () => {
    const old = [
      entry("meta_api", 1, { audio: { dir: "eval/recorded", synthetic: false } }),
      entry("meta_api", 2, { clipsSha256: "scripts-v0" }),
      entry("meta_api", 3, { runs: 1 }),
    ];
    const current = entry("open_weights", 4);
    expect(selectSummaryRuns([...old, current], "eval", "script")).toEqual([current]);
  });

  it("selects the newest matching run per route regardless of file or clip order", () => {
    const old = entry("open_weights", 1);
    const current = entry("open_weights", 3);
    const backup = entry("meta_api", 2, { clipIds: ["silence", "ask-by-name"] });
    expect(selectSummaryRuns([current, old, backup], "eval", "script")).toEqual([current, backup]);
    expect(selectSummaryRuns([current], "samples", "now")).toEqual([]);
  });
});
