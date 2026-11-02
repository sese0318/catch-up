import { describe, expect, it } from "vitest";
import { copyRuleProblems } from "../copy-rules";
import {
  ASK_CHIPS,
  CAPTURE_ERROR_COPY,
  PRIVACY,
  UI,
  allStaticCopy,
  cardHeading,
  cardWindow,
  catchUpName,
  clearCount,
  collectingLabel,
  earlierLabel,
  furtherBackLabel,
  hotkeyHint,
  hotkeyTaken,
  listeningLabel,
  memoryLabel,
  nameFormLabel,
  nextCardIn,
  partialLabel,
  playingLabel,
  quietHint,
  retryAfterLabel,
  savedRunLabel,
  sendingLabel,
  sendsLast,
  silentLabel,
  sourceChipName,
  sourceLostLabel,
  switchToLabel,
  textSizeLabel,
  timingLine,
  warmingNotice,
  windowLabel,
  windowWords,
} from "./copy";

const FORBIDDEN = /\b(invisible|stealth|undetectable)\b/i;
const MEDICAL = /\b(diagnos\w*|treatment|symptom\w*|focus score|ADHD mode)\b/i;

function dynamicCopy(): string[] {
  const out: string[] = [];
  for (const w of [30, 60, 120] as const) {
    out.push(windowLabel(w), windowWords(w), catchUpName(w), sendsLast(w), silentLabel(w), furtherBackLabel(w));
    out.push(cardWindow(w, w), cardWindow(w, 12.4));
  }
  for (const s of ["mic", "tab", "system", "sample"] as const) {
    out.push(listeningLabel(s), sourceLostLabel(s), quietHint(s));
  }
  for (const l of ["en", "ja", "zh"] as const) out.push(nextCardIn(l));
  out.push(
    sourceLostLabel(null),
    memoryLabel("1:24"),
    collectingLabel(3),
    collectingLabel(0),
    hotkeyHint("Ctrl+Alt+C", true),
    hotkeyHint("Ctrl+Alt+C", false),
    hotkeyTaken("Ctrl+Shift+Space"),
    earlierLabel(4),
    sendingLabel(30),
    partialLabel(12.2),
    warmingNotice(2),
    retryAfterLabel(1800),
    cardHeading("10:42"),
    savedRunLabel("Saved result from Muse Spark Open", "Nov 3"),
    playingLabel("An English ask by name"),
    clearCount(1),
    clearCount(5),
    nameFormLabel(2),
    textSizeLabel(125),
    switchToLabel("Apps on this computer"),
    sourceChipName("Tab audio"),
    timingLine({ total: 2900, firstToken: 2100, upload: 400 }),
  );
  return out;
}

describe("English chrome copy", () => {
  const all = [...allStaticCopy(), ...dynamicCopy()];

  it("has something to check", () => {
    expect(allStaticCopy().length).toBeGreaterThan(150);
  });

  it("follows the writing rules", () => {
    const bad = all.map((text) => ({ text, problems: copyRuleProblems(text) })).filter((r) => r.problems.length > 0);
    expect(bad).toEqual([]);
  });

  it("never sells hiding, and never sounds medical", () => {
    for (const text of all) {
      expect(text, text).not.toMatch(FORBIDDEN);
      expect(text, text).not.toMatch(MEDICAL);
    }
  });

  it("credits the model and states the limits", () => {
    expect(UI.builtWith).toBe("Built with Muse Spark Open");
    expect(PRIVACY.builtWith).toBe("Built with Muse Spark Open");
    expect(UI.adultsOnly).toMatch(/18 and over/);
    expect(UI.aiCanBeWrong).toMatch(/can be wrong/);
    expect(UI.consentLabel).toBe("People here know I'm using Catch Up");
  });

  it("names both routes, their model ids and their data terms", () => {
    const routes = PRIVACY.sections.find((s) => s.title === "Who hears it");
    expect(routes?.items.join(" ")).toContain("meta-models/muse-spark-open-1026");
    expect(routes?.items.join(" ")).toContain("muse-spark-1.3");
    expect(PRIVACY.links.map((l) => l.href)).toContain("https://docs.baseten.co/observability/security");
  });

  it("has copy for every capture error and every history chip", () => {
    expect(Object.keys(CAPTURE_ERROR_COPY).sort()).toEqual(
      [
        "device_error",
        "insecure_context",
        "no_audio_in_share",
        "permission_denied",
        "sample_failed",
        "share_cancelled",
        "unsupported",
      ].sort(),
    );
    expect(Object.keys(ASK_CHIPS).sort()).toEqual(["mentioned", "none", "room", "you"]);
  });

  it("keeps the press button name stable and spoken in full", () => {
    expect(catchUpName(30)).toBe("Catch up, send the last 30 seconds");
    expect(catchUpName(120)).toBe("Catch up, send the last 2 minutes");
  });
});
