// Small display helpers. Pure, so they run the same on the server and in tests.
import { widthOf } from "../card/schema";

/** 84 seconds as 1:24 (minutes and seconds, tabular in the UI). */
export function formatMemory(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Clock time of a local ISO string with offset (2026-11-02T10:42:40.123-05:00 gives 10:42).
 * pressedAt is written in the listener's own offset, so reading the digits keeps their wall clock.
 */
export function clockOfIso(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : "";
}

/** Seconds with one decimal, for receipts and timing lines. */
export function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** 2026-11-03 or a full ISO time as Nov 3. Falls back to the input when it has no date. */
export function formatRunDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : value;
}

/** Whole seconds left until a deadline, never negative. */
export function secondsUntil(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Cuts text at a code point boundary so widthOf(result) <= cap. For capping inputs, no ellipsis. */
export function cutToWidthUnits(text: string, cap: number): string {
  if (widthOf(text) <= cap) return text;
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = widthOf(ch);
    if (width + w > cap) break;
    out += ch;
    width += w;
  }
  return out;
}

/**
 * Caps one name form while the user types, so the forms joined with ", " never pass the cap.
 * Other forms keep their space, and blank forms do not count.
 */
export function fitNameForm(names: readonly string[], index: number, value: string, cap: number): string {
  const others = names.filter((n, i) => i !== index && n.trim() !== "").map((n) => n.trim());
  const othersWidth = others.length === 0 ? 0 : widthOf(others.join(", ")) + 2; // + ", " before this one
  return cutToWidthUnits(value, Math.max(0, cap - othersWidth));
}

/** Width of the forms as they would be sent, joined with ", ". */
export function namesWidth(names: readonly string[]): number {
  return widthOf(
    names
      .map((n) => n.trim())
      .filter(Boolean)
      .join(", "),
  );
}

/** Local file name for an export, for example catch-up-2026-11-02-1042.md. */
export function exportFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `catch-up-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}.md`;
}

/** Electron accelerator in the words people see, for example Control+Alt+C as Ctrl+Alt+C. */
export function acceleratorLabel(accelerator: string | null | undefined): string {
  if (!accelerator) return "";
  return accelerator.replace(/\bControl\b/g, "Ctrl").replace(/\bCommandOrControl\b/g, "Ctrl");
}
