import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Card, CARD_LANGS } from "@/lib/card/schema";
import { copyRuleProblems } from "@/lib/copy-rules";
import { ROUTE_PREFERENCES, checkClipWav, decodeMetaHeader, encodeMetaHeader, normalizeHint, normalizeNames, weekdayOfIso } from "@/lib/protocol";
import { DEV_SAMPLE_CLIPS, SAMPLE_CLIPS, getCachedCard, getSampleClip, listSampleClips } from "@/lib/samples/catalog";
import cachedCards from "@/lib/samples/cached-cards.json";
import { EVAL_DIR, clipsInSet, loadClipsFile, mockFixtureFor, pressMetaFor, transcriptOf, windowFor } from "./clips";

const file = loadClipsFile();
const byUse = (use: string) => file.clips.filter((c) => c.use === use);
const ROOT = join(EVAL_DIR, "..");

const WEEKDAY_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bMonday\b|月曜|周一|星期一/, "Monday"],
  [/\bTuesday\b|火曜|周二|星期二/, "Tuesday"],
  [/\bWednesday\b|水曜|周三|星期三/, "Wednesday"],
  [/\bThursday\b|木曜|周四|星期四/, "Thursday"],
  [/\bFriday\b|金曜|周五|星期五/, "Friday"],
  [/\bSaturday\b|土曜|周六|星期六/, "Saturday"],
  [/\bSunday\b|日曜|周日|星期日/, "Sunday"],
];

describe("eval/clips.json", () => {
  it("holds the 10 scripted scenes, the 3 sample scripts and a no-speech control", () => {
    expect(byUse("eval")).toHaveLength(10);
    expect(byUse("sample")).toHaveLength(3);
    expect(byUse("control").length).toBeGreaterThanOrEqual(1);
    expect(clipsInSet(file, "eval")).toHaveLength(10 + byUse("control").length);
    expect(clipsInSet(file, "samples")).toHaveLength(3);
  });

  it("keeps eval clips between 20 and 40 s and samples under 30 s", () => {
    for (const c of byUse("eval")) expect(c.durationSec, c.id).toBeGreaterThanOrEqual(20);
    for (const c of byUse("eval")) expect(c.durationSec, c.id).toBeLessThanOrEqual(40);
    for (const c of byUse("sample")) expect(c.durationSec, c.id).toBeLessThan(30);
  });

  it("covers every ask state, every card language and the three spoken languages", () => {
    const scripted = byUse("eval");
    expect(new Set(scripted.map((c) => c.gold.askTo))).toEqual(new Set(["you", "room", "mentioned", "none"]));
    expect(new Set(scripted.map((c) => c.cardLang))).toEqual(new Set(CARD_LANGS));
    expect(new Set(scripted.flatMap((c) => c.spokenLangs))).toEqual(new Set(["en", "ja", "zh"]));
    expect(scripted.some((c) => c.spokenLangs.length === 3)).toBe(true);
    expect(scripted.some((c) => c.gold.numbers.some((n) => n.confusable))).toBe(true);
    expect(scripted.some((c) => c.noise.kind === "cafe")).toBe(true);
    expect(scripted.some((c) => c.effect === "far")).toBe(true);
    for (const c of byUse("control")) expect(c.gold.heard).toContain("none");
  });

  it("resolves every gold date on or after its press day, on the weekday it was said as", () => {
    for (const c of file.clips) {
      const pressDay = (c.pressedAt ?? file.referenceTime).slice(0, 10);
      for (const d of c.gold.dates) {
        expect(d.date >= pressDay, `${c.id} ${d.said}`).toBe(true);
        const weekday = weekdayOfIso(`${d.date}T12:00:00Z`);
        for (const [pattern, name] of WEEKDAY_WORDS) {
          if (pattern.test(d.said)) expect(weekday, `${c.id} ${d.said}`).toBe(name);
        }
      }
    }
  });

  it("puts a question in every script that asks the listener or the room", () => {
    for (const c of file.clips.filter((x) => x.gold.askTo === "you" || x.gold.askTo === "room")) {
      expect(c.lines.some((l) => /[?？]$/.test(l.text)), c.id).toBe(true);
    }
    for (const c of file.clips.filter((x) => x.gold.askTo === "mentioned")) {
      expect(c.lines.some((l) => c.listener.some((n) => l.text.includes(n))), c.id).toBe(true);
    }
  });

  it("sends names, hints and headers that the protocol accepts as they are", () => {
    for (const c of file.clips) {
      expect(normalizeNames(c.listener), c.id).toEqual(c.listener);
      if (c.hint) expect(normalizeHint(c.hint)).toBe(c.hint);
      for (const route of ROUTE_PREFERENCES) {
        const meta = pressMetaFor(file, c, {
          route,
          sessionId: "eval-session-0001",
          sentSec: c.durationSec,
          mock: route === "mock" ? { mode: "ok", fixture: mockFixtureFor(c) } : undefined,
        });
        const decoded = decodeMetaHeader(encodeMetaHeader(meta));
        expect(decoded.ok, `${c.id} ${route}`).toBe(true);
        if (decoded.ok) expect(decoded.meta).toEqual(meta);
      }
    }
  });

  it("sends each clip whole, in the smallest window that holds it, at the script's press time", () => {
    const lecture = file.clips.find((c) => c.id === "en-lecture-far");
    expect(lecture?.pressedAt).toBeDefined();
    const meta = pressMetaFor(file, lecture!, { route: "auto", sessionId: "eval-session-0001", sentSec: 23 });
    expect(meta.pressedAt).toBe("2026-11-05T13:15:00.000-05:00");
    expect(meta.windowSec).toBe(30);
    expect(meta.sentSec).toBe(23);
    expect(windowFor(31)).toBe(60);
    expect(windowFor(125)).toBe(120);
    expect(pressMetaFor(file, file.clips[0], { route: "auto", sessionId: "eval-session-0001", sentSec: 27 }).pressedAt).toBe(
      "2026-11-02T10:30:00.000-05:00",
    );
  });

  it("keeps scene names, sample titles and blurbs inside the writing rules", () => {
    for (const c of file.clips) {
      expect(copyRuleProblems(c.scene), c.id).toEqual([]);
      if (c.sample) {
        expect(copyRuleProblems(c.sample.title), c.id).toEqual([]);
        expect(copyRuleProblems(c.sample.blurb), c.id).toEqual([]);
      }
      for (const line of c.lines) expect(copyRuleProblems(line.text), `${c.id} ${line.text}`).toEqual([]);
    }
  });
});

describe("DEV_SAMPLE_CLIPS", () => {
  const samples = byUse("sample");

  it("lists exactly the sample scripts", () => {
    expect(DEV_SAMPLE_CLIPS.map((c) => c.id)).toEqual(samples.map((c) => c.id));
  });

  it("matches every field of its script in eval/clips.json", () => {
    for (const script of samples) {
      const dev = DEV_SAMPLE_CLIPS.find((c) => c.id === script.id)!;
      expect(dev, script.id).toEqual({
        id: script.id,
        title: script.sample!.title,
        blurb: script.sample!.blurb,
        url: `/samples/dev/${script.id}.wav`,
        durationSec: script.durationSec,
        spokenLangs: script.spokenLangs,
        muffle: script.sample!.muffle,
        keyMomentSec: script.sample!.keyMomentSec,
        consent: "synthetic",
        cached: {},
        listenerNames: script.listener,
        meetingLang: script.meetingLang,
        transcript: transcriptOf(script),
      });
    }
  });

  it("keeps the muffle window about 4 s long and before the key moment", () => {
    for (const c of DEV_SAMPLE_CLIPS) {
      const length = c.muffle.endSec - c.muffle.startSec;
      expect(length, c.id).toBeGreaterThanOrEqual(3.5);
      expect(length, c.id).toBeLessThanOrEqual(6);
      expect(c.muffle.endSec, c.id).toBeLessThanOrEqual(c.keyMomentSec);
      expect(c.keyMomentSec, c.id).toBeLessThanOrEqual(c.durationSec);
    }
  });

  it("are listed outside production and never cached", () => {
    expect(listSampleClips().map((c) => c.id)).toEqual([...SAMPLE_CLIPS, ...DEV_SAMPLE_CLIPS].map((c) => c.id));
    expect(getSampleClip("sample-ask-by-name")?.url).toBe("/samples/dev/sample-ask-by-name.wav");
    for (const c of DEV_SAMPLE_CLIPS) for (const lang of CARD_LANGS) expect(getCachedCard(c.id, lang)).toBeNull();
  });
});

describe("public samples and saved cards", () => {
  it("ships only clips with written consent, outside the dev folder", () => {
    for (const c of SAMPLE_CLIPS) {
      expect(c.consent, c.id).toBe("written");
      expect(c.url.startsWith("/samples/"), c.id).toBe(true);
      expect(c.url.startsWith("/samples/dev/"), c.id).toBe(false);
      expect(c.durationSec, c.id).toBeLessThan(30);
      expect(copyRuleProblems(c.title)).toEqual([]);
      expect(copyRuleProblems(c.blurb)).toEqual([]);
    }
  });

  it("saves only real cached cards for public clips", () => {
    const saved = cachedCards as Record<string, Record<string, unknown>>;
    for (const [id, byLang] of Object.entries(saved)) {
      expect(SAMPLE_CLIPS.some((c) => c.id === id), id).toBe(true);
      for (const [lang, raw] of Object.entries(byLang)) {
        const card = Card.parse(raw);
        expect(card.meta.cardLang, `${id} ${lang}`).toBe(lang);
        expect(card.meta.route).toBe("cached");
        expect(card.meta.cachedFrom).toBeDefined();
        expect(card.meta.cachedRunAt).toBeDefined();
        expect(card.meta.source).toBe("sample");
      }
    }
  });
});

describe("generated audio", () => {
  const clipsDir = join(EVAL_DIR, "clips");
  const made = file.clips.filter((c) => existsSync(join(clipsDir, `${c.id}.wav`)));

  it.skipIf(made.length === 0)("is 16 kHz mono PCM16 at the length the scripts say", () => {
    for (const c of made) {
      const check = checkClipWav(readFileSync(join(clipsDir, `${c.id}.wav`)));
      expect(check.ok, c.id).toBe(true);
      if (check.ok) expect(Math.abs(check.wav.seconds - c.durationSec), c.id).toBeLessThan(0.02);
    }
  });

  it.skipIf(made.length === 0)("puts each sample in the dev folder with the timings the catalog uses", () => {
    const timingsPath = join(clipsDir, "timings.json");
    const timings = existsSync(timingsPath)
      ? (JSON.parse(readFileSync(timingsPath, "utf8")) as { clips: Record<string, { sample?: { muffle: { startSec: number; endSec: number }; keyMomentSec: number } }> })
      : null;
    for (const c of DEV_SAMPLE_CLIPS.filter((x) => made.some((m) => m.id === x.id))) {
      expect(existsSync(join(ROOT, "public", c.url)), c.id).toBe(true);
      const t = timings?.clips[c.id]?.sample;
      if (!t) continue;
      expect(Math.abs(t.muffle.startSec - c.muffle.startSec), c.id).toBeLessThanOrEqual(0.15);
      expect(Math.abs(t.muffle.endSec - c.muffle.endSec), c.id).toBeLessThanOrEqual(0.15);
      expect(Math.abs(t.keyMomentSec - c.keyMomentSec), c.id).toBeLessThanOrEqual(0.15);
    }
  });
});
