"use client";
// The app shell. Picks the layout for the surface (main page, phone, Windows app compact panel or
// Full view), owns which sheet is open, and runs the Start listening flow (setup once per device,
// then the per-session People here know tick, then capture started inside the click).
import { useState } from "react";
import { createPortal } from "react-dom";
import { UI } from "@/lib/client/copy";
import { useController, useIsPhone, useSession, useSettings, useSettingsStore } from "@/lib/client/hooks";
import { availableSources, effectiveSource, type LiveSource } from "@/lib/client/settings";
import { DevBanner, FloatNotes, Footer, Header } from "./Chrome";
import { History } from "./History";
import { Panel, PipPlaceholder } from "./Panel";
import { HistorySheet, MenuSheet, PrivacySheet, SettingsSheet, SetupSheet, SourceSheet } from "./Sheets";
import { SourceStep } from "./SourceStep";
import { CONSENT_ID, SAMPLES_ID, SOURCE_STEP_ID, UiContext, type SheetName, type UiActions } from "./ui-context";

type Layout = "web" | "phone" | "app-compact" | "app-full";

function focusById(id: string, doc: Document | null | undefined, scroll = true): boolean {
  const el = doc?.getElementById(id);
  if (!el) return false;
  if (scroll && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  el.focus({ preventScroll: true });
  return true;
}

function afterPaint(run: () => void): void {
  if (typeof window === "undefined") return;
  if (typeof window.requestAnimationFrame !== "function") {
    window.setTimeout(run, 0);
    return;
  }
  window.requestAnimationFrame(() => window.requestAnimationFrame(run));
}

export default function CatchUpApp() {
  const session = useSession();
  const { settings, setupDone } = useSettings();
  const store = useSettingsStore();
  const ctl = useController();
  const isPhone = useIsPhone();
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [pendingStart, setPendingStart] = useState(false);
  const [samplesRevealed, setSamplesRevealed] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);

  const desktopApp = session.desktop.present;
  const sources = availableSources(session.support, desktopApp);
  const source = effectiveSource(settings, sources, desktopApp);
  const layout: Layout = desktopApp
    ? session.desktop.view === "compact"
      ? "app-compact"
      : "app-full"
    : isPhone
      ? "phone"
      : "web";
  const capture = session.capture;
  const live = (capture.state === "listening" || capture.state === "starting") && capture.source !== "sample";
  const pipWindow = session.pip.window;

  // The document that holds the Panel right now, the floating window or this tab.
  const panelDoc = (): Document | null => pipWindow?.document ?? (typeof document === "undefined" ? null : document);

  const focusConsent = () => {
    focusById(CONSENT_ID, panelDoc());
  };

  const startNow = (chosen: LiveSource) => {
    if (chosen !== settings.source) store.update({ source: chosen, sourceChosen: true });
    if (ctl.startLive(chosen)) setSourceOpen(false);
  };

  const ui: UiActions = {
    samplesRevealed,
    source,
    sources,
    openSheet: (name) => setSheet(name),
    closeSheet: (name) => setSheet((current) => (name && current !== name ? current : null)),
    startListening: (chosen) => {
      const pick = chosen && sources.includes(chosen) ? chosen : source;
      if (!setupDone && !pipWindow) {
        setPendingStart(true);
        setSheet("setup");
        return;
      }
      if (!session.consent) {
        focusConsent();
        return;
      }
      startNow(pick);
    },
    useReal: () => {
      setSamplesRevealed(false);
      if (!setupDone) {
        setPendingStart(false);
        setSheet("setup");
        return;
      }
      // Phones only hear the room, so the next step is the tick and Start listening.
      if (layout === "phone") afterPaint(focusConsent);
      else ui.checkSource();
    },
    checkSource: () => {
      if (pipWindow) ctl.closePip();
      if (layout === "app-compact") {
        ctl.setDesktopView("full");
        return;
      }
      if (layout === "phone") {
        setSheet("source");
        return;
      }
      setSourceOpen(true);
      afterPaint(() => {
        if (!focusById(SOURCE_STEP_ID, document)) setSheet("source");
      });
    },
    revealSamples: () => {
      setSamplesRevealed(true);
      afterPaint(() => focusById(SAMPLES_ID, panelDoc()));
    },
  };

  const onSetupContinue = () => {
    store.markSetupDone();
    setSheet(null);
    const wasStarting = pendingStart;
    setPendingStart(false);
    if (wasStarting && session.consent) {
      // Still inside the Continue click, so the browser prompt is allowed.
      startNow(source);
      return;
    }
    afterPaint(() => {
      if (layout === "web" || layout === "app-full") {
        setSourceOpen(true);
        if (!focusById(SOURCE_STEP_ID, document)) focusConsent();
      } else {
        focusConsent();
      }
    });
  };

  const closeSheet = (name: SheetName) => () => ui.closeSheet(name);
  const showSource = !live || sourceOpen;

  let body: React.ReactNode;
  if (layout === "app-compact") {
    body = (
      <div className="cu-app" data-layout="app-compact">
        <Panel surface="app-compact" />
      </div>
    );
  } else if (layout === "phone") {
    body = (
      <div className="cu-app" data-layout="phone">
        <DevBanner />
        {pipWindow ? <PipPlaceholder /> : <Panel surface="phone" />}
      </div>
    );
  } else {
    const app = layout === "app-full";
    body = (
      <div className="cu-app" data-layout={layout}>
        <Header app={app} />
        <DevBanner />
        {!app ? <FloatNotes /> : null}
        <main className="cu-main">
          <div className="cu-col-panel">
            {pipWindow ? <PipPlaceholder /> : <Panel surface={app ? "app-full" : "web"} />}
          </div>
          <aside className="cu-col-side" aria-label={UI.asideLabel}>
            {showSource ? <SourceStep /> : null}
            <History />
          </aside>
        </main>
        <Footer app={app} />
      </div>
    );
  }

  return (
    <UiContext value={ui}>
      {body}
      <SetupSheet open={sheet === "setup"} onClose={closeSheet("setup")} onContinue={onSetupContinue} />
      <SettingsSheet open={sheet === "settings"} onClose={closeSheet("settings")} />
      <PrivacySheet open={sheet === "privacy"} onClose={closeSheet("privacy")} />
      <SourceSheet open={sheet === "source"} onClose={closeSheet("source")} />
      <HistorySheet open={sheet === "history"} onClose={closeSheet("history")} />
      <MenuSheet open={sheet === "menu"} onClose={closeSheet("menu")} />
      {pipWindow
        ? createPortal(
            <div className="cu-pip-root">
              <Panel surface="pip" />
            </div>,
            pipWindow.document.body,
          )
        : null}
    </UiContext>
  );
}
