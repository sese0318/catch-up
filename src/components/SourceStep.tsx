// The source step (ux-spec 5), every time listening starts, last choice preselected. Three tiles,
// a picture of the browser's picker before its dialog opens, the Zoom speaker tip, the headphones
// note for screen reader users, and the optional per-session hint.
import { CAPS } from "@/lib/card/schema";
import { PICKER, SOURCE_TILES, UI, switchToLabel } from "@/lib/client/copy";
import { useController, useSession, useSettingsStore } from "@/lib/client/hooks";
import type { LiveSource } from "@/lib/client/settings";
import { BrowserIcon, DesktopIcon, HeadphonesIcon, InfoIcon, MicrophoneIcon } from "./icons";
import { CappedInput, cx } from "./ui";
import { SOURCE_STEP_ID, useUi } from "./ui-context";

const TILE_ICONS: Record<LiveSource, typeof MicrophoneIcon> = {
  mic: MicrophoneIcon,
  tab: BrowserIcon,
  system: DesktopIcon,
};

/** A drawing of Chrome's share picker with the audio switch to turn on. */
export function PickerGuide({ kind }: { kind: "tab" | "system" }) {
  const toggleText = kind === "tab" ? PICKER.tabSwitch : PICKER.systemSwitch;
  const tabs = PICKER.tabs;
  const active = kind === "tab" ? 0 : 2;
  return (
    <figure className="cu-picker" lang="en">
      <svg viewBox="0 0 320 168" role="img" aria-labelledby={`cu-picker-${kind}`} className="cu-picker-svg">
        <title id={`cu-picker-${kind}`}>{kind === "tab" ? PICKER.tabTitle : PICKER.systemTitle}</title>
        <rect x="1" y="1" width="318" height="166" rx="8" className="cu-picker-frame" />
        <text x="16" y="24" className="cu-picker-heading">
          {PICKER.heading}
        </text>
        {tabs.map((t, i) => (
          <g key={t}>
            <text x={16 + i * 100} y="48" className={i === active ? "cu-picker-tab-on" : "cu-picker-tab"}>
              {t}
            </text>
            {i === active ? <rect x={16 + i * 100} y="54" width="72" height="3" rx="1.5" className="cu-picker-accent" /> : null}
          </g>
        ))}
        <rect x="16" y="66" width="288" height="44" rx="6" className="cu-picker-item" />
        <text x="28" y="92" className="cu-picker-label">
          {kind === "tab" ? PICKER.tabItem : PICKER.screenItem}
        </text>
        <rect x="12" y="120" width="214" height="36" rx="18" className="cu-picker-ring" />
        <rect x="24" y="130" width="30" height="16" rx="8" className="cu-picker-switch" />
        <circle cx="46" cy="138" r="6" className="cu-picker-knob" />
        <text x="64" y="143" className="cu-picker-label">
          {toggleText}
        </text>
        <rect x="244" y="126" width="60" height="26" rx="6" className="cu-picker-share" />
        <text x="260" y="143" className="cu-picker-share-text">
          {PICKER.share}
        </text>
      </svg>
      <figcaption className="cu-muted">{kind === "tab" ? UI.pickerTabGuide : UI.pickerSystemGuide}</figcaption>
    </figure>
  );
}

export function HintInput({ id = "cu-hint" }: { id?: string }) {
  const session = useSession();
  const ctl = useController();
  return (
    <div className="cu-field" lang="en">
      <CappedInput
        id={id}
        label={UI.hintLabel}
        value={session.hint}
        cap={CAPS.sessionHint}
        placeholder={UI.hintPlaceholder}
        describedBy={`${id}-help`}
        onValue={(value) => ctl.setHint(value)}
      />
      <p id={`${id}-help`} className="cu-help">
        {UI.hintHelp}
      </p>
    </div>
  );
}

export function SourceStep({ inSheet = false }: { inSheet?: boolean }) {
  const session = useSession();
  const store = useSettingsStore();
  const ui = useUi();
  const capture = session.capture;
  const live = capture.state === "listening" && capture.source !== "sample";
  const selected = ui.source;
  const desktopApp = session.desktop.present;
  const showChromeNote = !session.support.phone && !desktopApp && !ui.sources.includes("tab") && session.initialized;

  return (
    <section className="cu-source" id={inSheet ? undefined : SOURCE_STEP_ID} aria-labelledby="cu-source-h" tabIndex={-1}>
      {!inSheet ? (
        <h2 id="cu-source-h" className="cu-side-title" lang="en">
          {UI.sourceTitle}
        </h2>
      ) : (
        <span id="cu-source-h" className="sr-only" lang="en">
          {UI.sourceTitle}
        </span>
      )}
      <p className="cu-muted" lang="en">
        {UI.sourceHelp}
      </p>
      <fieldset className="cu-tiles">
        <legend className="sr-only" lang="en">
          {UI.sourceTitle}
        </legend>
        {ui.sources.map((source) => {
          const Icon = TILE_ICONS[source];
          const tile = SOURCE_TILES[source];
          return (
            <label key={source} className={cx("cu-tile", selected === source && "cu-tile-on")} lang="en">
              <input
                type="radio"
                name="cu-source"
                value={source}
                checked={selected === source}
                onChange={() => store.update({ source, sourceChosen: true })}
              />
              <Icon aria-hidden="true" className="cu-tile-icon" />
              <span className="cu-tile-text">
                <span className="cu-tile-title">{tile.title}</span>
                <span className="cu-tile-detail">{tile.detail}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {session.support.phone ? (
        <p className="cu-muted" lang="en">
          {UI.phoneOnlyRoom}
        </p>
      ) : null}
      {showChromeNote ? (
        <p className="cu-note" lang="en">
          <InfoIcon aria-hidden="true" />
          <span>{UI.needsChrome}</span>
        </p>
      ) : null}
      {selected === "system" && desktopApp ? (
        <p className="cu-note" lang="en">
          <InfoIcon aria-hidden="true" />
          <span>{UI.appSystemNote}</span>
        </p>
      ) : null}
      {(selected === "tab" || selected === "system") && !desktopApp ? <PickerGuide kind={selected} /> : null}
      {selected === "system" ? (
        <p className="cu-note" lang="en">
          <InfoIcon aria-hidden="true" />
          <span>{UI.zoomTip}</span>
        </p>
      ) : null}
      {selected !== "mic" ? (
        <p className="cu-note" lang="en">
          <HeadphonesIcon aria-hidden="true" />
          <span>{UI.headphonesNote}</span>
        </p>
      ) : null}
      <HintInput id={inSheet ? "cu-hint-sheet" : "cu-hint"} />
      {live && session.lastLiveSource !== selected ? (
        <button type="button" className="cu-btn cu-btn-primary cu-btn-wide" onClick={() => ui.startListening(selected)} lang="en">
          {switchToLabel(SOURCE_TILES[selected].title)}
        </button>
      ) : null}
    </section>
  );
}
