// Page-level UI actions shared by the Panel on every surface (main page, floating window, phone,
// Windows app). The floating window renders through a portal, so it shares this context too.
import { createContext, useContext } from "react";
import type { LiveSource } from "@/lib/client/settings";

export type SheetName = "setup" | "settings" | "privacy" | "source" | "history" | "menu";

export type PanelSurface = "web" | "phone" | "pip" | "app-compact" | "app-full";

export interface UiActions {
  openSheet(name: SheetName): void;
  /** Closes the named sheet, or any sheet. A sheet closing because another opened leaves the new one open. */
  closeSheet(name?: SheetName): void;
  /** The Start listening flow. Call it inside the click, it may start capture synchronously. */
  startListening(source?: LiveSource): void;
  /** Use it on a real conversation. Setup once per device, then the source step. */
  useReal(): void;
  /** Check source. The source step on wide screens, a sheet elsewhere. */
  checkSource(): void;
  /** Try a sample. Shows the sample strip in the card area. */
  revealSamples(): void;
  samplesRevealed: boolean;
  /** The live source the next Start listening uses. */
  source: LiveSource;
  sources: readonly LiveSource[];
}

const noop = () => undefined;

export const UiContext = createContext<UiActions>({
  openSheet: noop,
  closeSheet: noop,
  startListening: noop,
  useReal: noop,
  checkSource: noop,
  revealSamples: noop,
  samplesRevealed: false,
  source: "mic",
  sources: ["mic"],
});

export function useUi(): UiActions {
  return useContext(UiContext);
}

/** The id of the consent checkbox, so Start listening can send focus to it. */
export const CONSENT_ID = "cu-consent";
export const SOURCE_STEP_ID = "cu-source-step";
export const SAMPLES_ID = "cu-samples";
