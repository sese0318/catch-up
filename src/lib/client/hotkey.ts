// In-page keys (ux-spec 3 The one action, 6 item 6). Ctrl+Alt+C presses, with Ctrl+Shift+Space and
// Ctrl+Alt+Space as fallbacks for keyboards where Ctrl+Alt+C is taken. Esc cancels. No
// single-letter shortcuts. Handlers skip IME composition, and AltGr layouts keep their characters.

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
}

/** True while an IME is composing (isComposing or the legacy keyCode 229). */
export function isComposing(e: KeyLike): boolean {
  return e.isComposing === true || e.keyCode === 229;
}

/** True for Ctrl+Alt+C, Ctrl+Shift+Space or Ctrl+Alt+Space, never with AltGr or the Windows key. */
export function isCatchUpCombo(e: KeyLike): boolean {
  if (isComposing(e) || e.metaKey || !e.ctrlKey) return false;
  if (e.getModifierState?.("AltGraph")) return false;
  // Keys sent by voice control or other input tools can arrive without a code, so read key then.
  const isC = e.code === "KeyC" || (!e.code && e.key.toLowerCase() === "c");
  const isSpace = e.code === "Space" || (!e.code && e.key === " ");
  if (e.altKey && !e.shiftKey && isC) return true;
  if (isSpace && ((e.shiftKey && !e.altKey) || (e.altKey && !e.shiftKey))) return true;
  return false;
}

export function isEscape(e: KeyLike): boolean {
  return !isComposing(e) && (e.key === "Escape" || e.code === "Escape");
}

/** Epoch ms of a DOM event, so the press clock starts at keydown or pointerdown. */
export function eventEpochMs(event: { timeStamp: number }, now: () => number = Date.now): number {
  const origin = typeof performance !== "undefined" ? performance.timeOrigin : 0;
  if (origin > 0 && event.timeStamp > 0) {
    const at = origin + event.timeStamp;
    const wall = now();
    // Guard against clocks that disagree (sleep, clock changes). Trust the wall clock then.
    if (Math.abs(wall - at) < 5_000) return Math.round(at);
  }
  return now();
}

/** Ctrl+Alt+C as keyboard users see it, plus the aria-keyshortcuts value. */
export const WEB_HOTKEY = { label: "Ctrl+Alt+C", aria: "Control+Alt+C" } as const;
