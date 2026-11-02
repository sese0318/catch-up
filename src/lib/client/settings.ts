// Settings kept on the device (ux-spec 3 Settings and 5 item 8). They are the only thing Catch Up
// keeps, all in localStorage inside try and catch, and the page renders fine without storage.
// A small external store, read with useSyncExternalStore, so the server render uses the defaults
// and the client switches to the saved values after hydration without a mismatch.
import { z } from "zod";
import { CAPS, CARD_LANGS, type CardLang, type WindowSec } from "../card/schema";
import { cutToWidthUnits, fitNameForm } from "./format";

export const SETTINGS_KEY = "catchup.settings.v1";
export const SETUP_KEY = "catchup.setup.v1";
export const HINTS_KEY = "catchup.hints.v1";

export const TEXT_SIZES = [100, 125, 150] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const SETTINGS_ROUTES = ["auto", "open_weights", "meta_api"] as const;
export type SettingsRoute = (typeof SETTINGS_ROUTES)[number];
export const LIVE_SOURCES = ["mic", "tab", "system"] as const;
export type LiveSource = (typeof LIVE_SOURCES)[number];
export const ONE_TIME_HINTS = ["pip", "phone", "pipUnsupported"] as const;
export type OneTimeHint = (typeof ONE_TIME_HINTS)[number];

export interface Settings {
  cardLang: CardLang;
  meetingLang: CardLang;
  names: readonly [string, string, string];
  windowSec: WindowSec;
  textSize: TextSize;
  route: SettingsRoute;
  showTiming: boolean;
  source: LiveSource;
  /** False until someone picks a source tile, so the Windows app can start on system audio. */
  sourceChosen: boolean;
}

export interface SettingsState {
  settings: Settings;
  setupDone: boolean;
  hintsSeen: Readonly<Partial<Record<OneTimeHint, true>>>;
  /** False until the client has read storage. */
  loaded: boolean;
}

/** ja gives ja, zh gives zh, anything else gives en (locked decision 4). */
export function detectCardLang(language: string | null | undefined): CardLang {
  const tag = (language ?? "").toLowerCase();
  if (tag === "ja" || tag.startsWith("ja-")) return "ja";
  if (tag === "zh" || tag.startsWith("zh-")) return "zh";
  return "en";
}

export function defaultSettings(language?: string | null): Settings {
  return {
    cardLang: detectCardLang(language),
    meetingLang: "en",
    names: ["", "", ""],
    windowSec: 30,
    textSize: 100,
    route: "auto",
    showTiming: false,
    source: "mic",
    sourceChosen: false,
  };
}

const Stored = z
  .object({
    cardLang: z.enum(CARD_LANGS),
    meetingLang: z.enum(CARD_LANGS),
    names: z.array(z.string()),
    windowSec: z.union([z.literal(30), z.literal(60), z.literal(120)]),
    textSize: z.union([z.literal(100), z.literal(125), z.literal(150)]),
    route: z.enum(SETTINGS_ROUTES),
    showTiming: z.boolean(),
    source: z.enum(LIVE_SOURCES),
    sourceChosen: z.boolean(),
  })
  .partial();

/** Caps the three name forms the way the inputs do, so stored values always fit the header. */
export function normalizeStoredNames(names: readonly string[]): [string, string, string] {
  const out: [string, string, string] = ["", "", ""];
  for (let i = 0; i < 3; i++) {
    const value = typeof names[i] === "string" ? names[i] : "";
    out[i] = fitNameForm(out, i, value, CAPS.listenerNames);
  }
  return out;
}

/** Saved settings over the defaults. Anything unreadable or out of range falls back field by field. */
export function sanitizeSettings(raw: unknown, base: Settings): Settings {
  if (!raw || typeof raw !== "object") return base;
  const fields: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(Stored.shape)) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = (schema as z.ZodType).safeParse(value);
    if (parsed.success) fields[key] = parsed.data;
  }
  const next = { ...base, ...fields } as Settings;
  return { ...next, names: normalizeStoredNames(next.names) };
}

export function capHint(text: string): string {
  return cutToWidthUnits(text, CAPS.sessionHint);
}

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode, blocked storage or a full quota. The setting still applies for this tab.
  }
}

/** The live sources this device can use (ux-spec 3 Sources, 5 Source step). Phones hear the room only. */
export function availableSources(
  support: { phone: boolean; mic: boolean; tab: boolean; system: boolean },
  desktopApp: boolean,
): LiveSource[] {
  if (support.phone) return ["mic"];
  const out: LiveSource[] = ["mic"];
  if (support.tab && !desktopApp) out.push("tab");
  if (support.system || desktopApp) out.push("system");
  return out;
}

/** The source Start listening uses. The last choice when it is available, system audio first in the Windows app. */
export function effectiveSource(settings: Pick<Settings, "source" | "sourceChosen">, sources: readonly LiveSource[], desktopApp: boolean): LiveSource {
  if (desktopApp && !settings.sourceChosen && sources.includes("system")) return "system";
  return sources.includes(settings.source) ? settings.source : sources[0];
}

/** Applies text size to the root element (everything is in rem). Mirrors the inline script in layout.tsx. */
export function applyTextSize(doc: Document, size: TextSize): void {
  if (size === 100) delete doc.documentElement.dataset.textSize;
  else doc.documentElement.dataset.textSize = String(size);
}

export interface SettingsStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SettingsState;
  getServerSnapshot(): SettingsState;
  update(patch: Partial<Settings>): void;
  setName(index: 0 | 1 | 2, value: string): void;
  markSetupDone(): void;
  markHintSeen(hint: OneTimeHint): void;
}

const SERVER_STATE: SettingsState = { settings: defaultSettings(), setupDone: false, hintsSeen: {}, loaded: false };

export function createSettingsStore(): SettingsStore {
  let state: SettingsState | null = null;
  const listeners = new Set<() => void>();

  const load = (): SettingsState => {
    if (typeof window === "undefined") return SERVER_STATE;
    const base = defaultSettings(typeof navigator === "undefined" ? undefined : navigator.language);
    const settings = sanitizeSettings(readJson(SETTINGS_KEY), base);
    const setup = readJson(SETUP_KEY);
    const hints = readJson(HINTS_KEY);
    const hintsSeen: Partial<Record<OneTimeHint, true>> = {};
    if (hints && typeof hints === "object") {
      for (const hint of ONE_TIME_HINTS) if ((hints as Record<string, unknown>)[hint] === true) hintsSeen[hint] = true;
    }
    return { settings, setupDone: setup === true, hintsSeen, loaded: true };
  };

  const current = (): SettingsState => {
    if (!state) {
      state = load();
      if (typeof document !== "undefined") applyTextSize(document, state.settings.textSize);
    }
    return state;
  };

  const set = (next: SettingsState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key === SETTINGS_KEY || event.key === SETUP_KEY || event.key === HINTS_KEY) {
      const next = load();
      if (typeof document !== "undefined") applyTextSize(document, next.settings.textSize);
      set(next);
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot: current,
    getServerSnapshot: () => SERVER_STATE,
    update(patch) {
      const prev = current();
      const settings = sanitizeSettings({ ...prev.settings, ...patch }, prev.settings);
      writeJson(SETTINGS_KEY, settings);
      if (typeof document !== "undefined" && settings.textSize !== prev.settings.textSize) {
        applyTextSize(document, settings.textSize);
      }
      set({ ...prev, settings });
    },
    setName(index, value) {
      const prev = current();
      const names = [...prev.settings.names] as [string, string, string];
      names[index] = fitNameForm(names, index, value, CAPS.listenerNames);
      const settings = { ...prev.settings, names };
      writeJson(SETTINGS_KEY, settings);
      set({ ...prev, settings });
    },
    markSetupDone() {
      writeJson(SETUP_KEY, true);
      set({ ...current(), setupDone: true });
    },
    markHintSeen(hint) {
      const prev = current();
      const hintsSeen = { ...prev.hintsSeen, [hint]: true as const };
      writeJson(HINTS_KEY, hintsSeen);
      set({ ...prev, hintsSeen });
    },
  };
}

let shared: SettingsStore | null = null;

/** The one settings store for the page (and its floating window, which shares the page's JS). */
export function getSettingsStore(): SettingsStore {
  if (!shared) shared = createSettingsStore();
  return shared;
}
