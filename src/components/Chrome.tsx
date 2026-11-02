// Page chrome around the Panel. Header with the card language switch, Float on top and Settings,
// the dev-only mock banner, one-time floating window notes, and the footer with the promise,
// Built with Muse Spark Open and How your audio is handled.
import { CARD_LANGS, type CardLang } from "@/lib/card/schema";
import { LANG_SHORT, UI } from "@/lib/client/copy";
import { useController, useSession, useSettings, useSettingsStore } from "@/lib/client/hooks";
import { tagOf } from "@/lib/client/local";
import { planRoute } from "@/lib/client/route";
import { ArrowsInSimpleIcon, GearIcon, InfoIcon, PictureInPictureIcon, ShieldCheckIcon } from "./icons";
import { Notice, RadioChips } from "./ui";
import { useUi } from "./ui-context";

export function Header({ app = false }: { app?: boolean }) {
  const session = useSession();
  const { settings } = useSettings();
  const store = useSettingsStore();
  const ctl = useController();
  const ui = useUi();
  const listening = session.capture.state === "listening";
  const canFloat = session.pip.supported && listening && !session.pip.window;
  return (
    <header className="cu-header" data-drag={app || undefined}>
      <div className="cu-header-inner">
        <span className="cu-wordmark" lang="en">
          <span className="cu-logo" aria-hidden="true" />
          {UI.appName}
        </span>
        <span className="cu-header-label" aria-hidden="true" lang="en">
          {UI.cardsIn}
        </span>
        <RadioChips<CardLang>
          legend={UI.cardsIn}
          hideLegend
          className="cu-header-langs"
          options={CARD_LANGS.map((lang) => ({ value: lang, label: LANG_SHORT[lang], lang: tagOf(lang) }))}
          value={settings.cardLang}
          onChange={(cardLang) => store.update({ cardLang })}
        />
        <span className="cu-header-spacer" />
        {canFloat ? (
          <button
            type="button"
            className="cu-btn cu-btn-quiet"
            onClick={() => {
              void ctl.openPip();
              store.markHintSeen("pip");
            }}
            lang="en"
          >
            <PictureInPictureIcon aria-hidden="true" />
            <span>{UI.floatOnTop}</span>
          </button>
        ) : null}
        {app ? (
          <button type="button" className="cu-btn cu-btn-quiet" onClick={() => ctl.setDesktopView("compact")} lang="en">
            <ArrowsInSimpleIcon aria-hidden="true" />
            <span>{UI.compactView}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="cu-icon-btn"
          onClick={() => ui.openSheet("settings")}
          aria-label={UI.settings}
          title={UI.settings}
          lang="en"
        >
          <GearIcon aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

export function DevBanner() {
  const session = useSession();
  const { settings } = useSettings();
  const plan = planRoute(settings.route, session.health, session.mockParam);
  if (plan.route !== "mock") return null;
  return (
    <div className="cu-dev-banner" role="note" lang="en">
      {UI.devMockBanner}
    </div>
  );
}

/** Float on top notes for the main page. One-time hint, unsupported browsers, and a closed window. */
export function FloatNotes() {
  const session = useSession();
  const { hintsSeen } = useSettings();
  const store = useSettingsStore();
  const ctl = useController();
  const listening = session.capture.state === "listening";
  if (session.desktop.present || session.support.phone) return null;

  if (session.pip.closedUnexpectedly) {
    return (
      <div className="cu-float-notes">
        <Notice
          tone="info"
          icon={<InfoIcon aria-hidden="true" />}
          actions={
            <>
              {listening && session.pip.supported ? (
                <button
                  type="button"
                  className="cu-btn cu-btn-secondary cu-btn-small"
                  onClick={() => {
                    void ctl.openPip();
                  }}
                >
                  <PictureInPictureIcon aria-hidden="true" />
                  <span>{UI.floatAgain}</span>
                </button>
              ) : null}
              <button type="button" className="cu-btn cu-btn-quiet cu-btn-small" onClick={() => ctl.dismissPipNote()}>
                {UI.gotIt}
              </button>
            </>
          }
        >
          {UI.pipClosedNote}
        </Notice>
      </div>
    );
  }

  if (!listening || session.pip.window) return null;

  if (session.pip.supported && !hintsSeen.pip) {
    return (
      <div className="cu-float-notes">
        <Notice
          tone="info"
          icon={<PictureInPictureIcon aria-hidden="true" />}
          actions={
            <>
              <button
                type="button"
                className="cu-btn cu-btn-secondary cu-btn-small"
                onClick={() => {
                  void ctl.openPip();
                  store.markHintSeen("pip");
                }}
              >
                {UI.floatOnTop}
              </button>
              <button type="button" className="cu-btn cu-btn-quiet cu-btn-small" onClick={() => store.markHintSeen("pip")}>
                {UI.gotIt}
              </button>
            </>
          }
        >
          <p>{UI.pipHint}</p>
          <p className="cu-notice-sub">{UI.pipOneWindow}</p>
        </Notice>
      </div>
    );
  }

  if (!session.pip.supported && session.initialized && !hintsSeen.pipUnsupported) {
    return (
      <div className="cu-float-notes">
        <Notice
          tone="info"
          icon={<InfoIcon aria-hidden="true" />}
          actions={
            <button
              type="button"
              className="cu-btn cu-btn-quiet cu-btn-small"
              onClick={() => store.markHintSeen("pipUnsupported")}
            >
              {UI.gotIt}
            </button>
          }
        >
          {UI.pipUnsupported}
        </Notice>
      </div>
    );
  }
  return null;
}

export function Footer({ app = false }: { app?: boolean }) {
  const ui = useUi();
  return (
    <footer className="cu-footer" lang="en">
      <p>
        {app ? UI.footerAudioApp : UI.footerAudio} <strong className="cu-built-with">{UI.builtWith}</strong>.
      </p>
      <p>
        {UI.aiCanBeWrong} {UI.adultsOnly}{" "}
        <button type="button" className="cu-link-btn" onClick={() => ui.openSheet("privacy")}>
          <ShieldCheckIcon aria-hidden="true" />
          <span>{UI.howAudioHandled}</span>
        </button>
      </p>
    </footer>
  );
}
