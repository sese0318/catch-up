// Document Picture-in-Picture for Float on top (ux-spec 4 PiP mini panel, browser-audio.md 4).
// The floating window only hosts DOM. State, capture and presses stay in the opener tab, and the
// Panel renders into the window through a React portal.

export const PIP_SIZE = { width: 360, height: 440 } as const;

interface DocPip {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

function docPip(): DocPip | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture ?? null;
}

export function isDocPipSupported(): boolean {
  return docPip() !== null;
}

/** Copies the opener's root attributes (theme, lang, text size) and style sheets into the window. */
export function preparePipDocument(win: Window, source: Document = document): void {
  const target = win.document;
  const base = target.createElement("base");
  base.href = source.baseURI; // root-relative font URLs in copied inline styles resolve against the app
  target.head.appendChild(base);
  syncRootAttributes(win, source);
  const meta = target.createElement("meta");
  meta.name = "color-scheme";
  meta.content = "light dark";
  target.head.appendChild(meta);
  for (const sheet of Array.from(source.styleSheets)) {
    if (sheet.href) {
      const link = target.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      if (sheet.media.mediaText) link.media = sheet.media.mediaText;
      target.head.appendChild(link);
      continue;
    }
    try {
      const style = target.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      target.head.appendChild(style);
    } catch {
      // A sheet that cannot be read is skipped.
    }
  }
  target.title = "Catch Up";
  target.body.classList.add("cu-pip-body");
}

/** Keeps lang, data-text-size and theme classes in step with the opener. */
export function syncRootAttributes(win: Window, source: Document = document): void {
  const html = win.document.documentElement;
  for (const attr of Array.from(html.attributes)) {
    if (!source.documentElement.hasAttribute(attr.name)) html.removeAttribute(attr.name);
  }
  for (const attr of Array.from(source.documentElement.attributes)) html.setAttribute(attr.name, attr.value);
}

/**
 * Opens the floating window. Call it directly in a click handler, because Chrome needs the click
 * (transient activation) and nothing may be awaited first. Resolves null when unsupported.
 */
export function openPipWindow(): Promise<Window | null> {
  const api = docPip();
  if (!api) return Promise.resolve(null);
  if (api.window) return Promise.resolve(api.window);
  return api.requestWindow({ width: PIP_SIZE.width, height: PIP_SIZE.height }).then(
    (win) => {
      preparePipDocument(win);
      return win;
    },
    () => null,
  );
}
