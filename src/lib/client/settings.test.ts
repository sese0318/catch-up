// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { CAPS } from "../card/schema";
import { namesWidth } from "./format";
import {
  SETTINGS_KEY,
  SETUP_KEY,
  availableSources,
  createSettingsStore,
  defaultSettings,
  detectCardLang,
  effectiveSource,
  sanitizeSettings,
} from "./settings";

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.textSize;
});

describe("card language default", () => {
  it("follows the browser language, ja and zh, else en", () => {
    expect(detectCardLang("ja")).toBe("ja");
    expect(detectCardLang("ja-JP")).toBe("ja");
    expect(detectCardLang("zh-CN")).toBe("zh");
    expect(detectCardLang("zh-Hant-TW")).toBe("zh");
    expect(detectCardLang("en-US")).toBe("en");
    expect(detectCardLang("fr")).toBe("en");
    expect(detectCardLang(undefined)).toBe("en");
  });
});

describe("saved settings", () => {
  it("falls back field by field on anything unreadable", () => {
    const base = defaultSettings("en");
    const out = sanitizeSettings(
      { cardLang: "ko", meetingLang: "ja", windowSec: 45, textSize: 150, route: "mock", showTiming: "yes", names: [1, "Seika"] },
      base,
    );
    expect(out.cardLang).toBe("en");
    expect(out.meetingLang).toBe("ja");
    expect(out.windowSec).toBe(30);
    expect(out.textSize).toBe(150);
    expect(out.route).toBe("auto");
    expect(out.showTiming).toBe(false);
    expect(out.names).toEqual(["", "", ""]); // names that are not all strings are dropped
    expect(sanitizeSettings("garbage", base)).toBe(base);
  });

  it("caps stored names so the joined forms fit the header", () => {
    const out = sanitizeSettings({ names: ["Seika", "セイカ", "星".repeat(80)] }, defaultSettings("en"));
    expect(namesWidth(out.names)).toBeLessThanOrEqual(CAPS.listenerNames);
  });

  it("persists in localStorage and survives broken storage", () => {
    const store = createSettingsStore();
    expect(store.getSnapshot().loaded).toBe(true);
    store.update({ windowSec: 60, textSize: 125 });
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}")).toMatchObject({ windowSec: 60, textSize: 125 });
    expect(document.documentElement.dataset.textSize).toBe("125");
    store.setName(0, "Seika");
    store.markSetupDone();
    expect(window.localStorage.getItem(SETUP_KEY)).toBe("true");

    const again = createSettingsStore();
    expect(again.getSnapshot()).toMatchObject({ setupDone: true, settings: { windowSec: 60, names: ["Seika", "", ""] } });

    window.localStorage.setItem(SETTINGS_KEY, "{not json");
    expect(createSettingsStore().getSnapshot().settings.windowSec).toBe(30);
  });

  it("keeps the server snapshot stable and default", () => {
    const store = createSettingsStore();
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
    expect(store.getServerSnapshot().settings.cardLang).toBe("en");
  });
});

describe("sources", () => {
  const support = { phone: false, mic: true, tab: true, system: true };
  it("hears only the room on phones and never offers tab audio in the Windows app", () => {
    expect(availableSources({ ...support, phone: true }, false)).toEqual(["mic"]);
    expect(availableSources(support, false)).toEqual(["mic", "tab", "system"]);
    expect(availableSources({ ...support, system: false }, true)).toEqual(["mic", "system"]);
    expect(availableSources({ ...support, tab: false, system: false }, false)).toEqual(["mic"]);
  });

  it("starts the Windows app on system audio until someone picks a source", () => {
    expect(effectiveSource({ source: "mic", sourceChosen: false }, ["mic", "system"], true)).toBe("system");
    expect(effectiveSource({ source: "mic", sourceChosen: true }, ["mic", "system"], true)).toBe("mic");
    expect(effectiveSource({ source: "tab", sourceChosen: true }, ["mic"], false)).toBe("mic");
  });
});
