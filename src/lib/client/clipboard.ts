// Copy line, Copy card and Copy for chat. The Windows app copies through its main process, because
// its panel never takes focus. The floating window copies through its own clipboard, because the
// opener tab is not focused while someone clicks in the floating window.
import { getDesktopBridge } from "../audio/types";

function copyWithTextarea(text: string, win: Window): boolean {
  try {
    const doc = win.document;
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copies text from the window the click happened in. Resolves false instead of throwing. */
export async function copyText(text: string, from?: Window | null): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (bridge) {
    try {
      return await bridge.copyText(text);
    } catch {
      return false;
    }
  }
  const win = from ?? (typeof window === "undefined" ? null : window);
  if (!win) return false;
  try {
    if (win.navigator.clipboard?.writeText) {
      await win.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Not focused or not allowed. Try the older path below.
  }
  return copyWithTextarea(text, win);
}

/** The window that owns an element, so a click in the floating window copies there. */
export function ownerWindowOf(target: EventTarget | null): Window | null {
  if (target && typeof (target as Node).ownerDocument === "object") {
    return (target as Node).ownerDocument?.defaultView ?? null;
  }
  return typeof window === "undefined" ? null : window;
}
