// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Sheet } from "./Sheets";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

type Name = "menu" | "settings";

/** The phone flow. Menu opens Settings, which replaces it, like CatchUpApp's single sheet state. */
function Harness() {
  const [sheet, setSheet] = useState<Name | null>(null);
  const closeSheet = (name: Name) => () => setSheet((current) => (current === name ? null : current));
  return (
    <>
      <button type="button" id="menu-opener" onClick={() => setSheet("menu")}>
        Menu
      </button>
      <button type="button" className="cu-big">
        Catch up
      </button>
      <Sheet open={sheet === "settings"} onClose={closeSheet("settings")} title="Settings">
        <p>Settings body</p>
      </Sheet>
      <Sheet open={sheet === "menu"} onClose={closeSheet("menu")} title="Menu">
        <button type="button" id="to-settings" onClick={() => setSheet("settings")}>
          Settings
        </button>
      </Sheet>
    </>
  );
}

const dialogs = () => [...(container?.querySelectorAll("dialog") ?? [])];

describe("sheets", () => {
  it("returns focus to the Menu button after Settings opened from the Menu closes", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));

    const opener = container.querySelector<HTMLButtonElement>("#menu-opener");
    opener?.focus();
    await act(async () => opener?.click());
    const toSettings = container.querySelector<HTMLButtonElement>("#to-settings");
    expect(toSettings).not.toBeNull();
    toSettings?.focus();
    await act(async () => toSettings?.click());

    // The menu dialog closes as Settings opens, and its close event lands while Settings is open.
    const [settings, menu] = dialogs();
    await act(async () => menu.dispatchEvent(new Event("close")));
    expect(settings.textContent).toContain("Settings body");

    await act(async () => settings.dispatchEvent(new Event("close")));
    expect(settings.textContent).not.toContain("Settings body");
    expect(document.activeElement).toBe(opener);
  });
});
