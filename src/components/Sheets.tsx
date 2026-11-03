// Sheets on native <dialog> (focus stays inside, Esc closes, focus returns to the opener).
// Setup once per device, Settings, How your audio is handled, and on phones the menu and history.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CAPS, CARD_LANGS, type CardLang } from "@/lib/card/schema";
import { DESKTOP_HOTKEY_PRESETS, type DesktopHotkeyPreset } from "@/lib/audio/types";
import { LANG_NAMES, NAME_PLACEHOLDERS, PRIVACY, UI, hotkeyTaken, nameFormLabel, textSizeLabel, windowLabel } from "@/lib/client/copy";
import { acceleratorLabel } from "@/lib/client/format";
import { useController, useSession, useSettings, useSettingsStore } from "@/lib/client/hooks";
import { tagOf } from "@/lib/client/local";
import { liveRoutesConfigured } from "@/lib/client/route";
import { TEXT_SIZES, type SettingsRoute } from "@/lib/client/settings";
import { History } from "./History";
import { GearIcon, ShieldCheckIcon, XIcon } from "./icons";
import { PrivacyContent } from "./PrivacyContent";
import { HintInput, SourceStep } from "./SourceStep";
import { CappedInput, RadioChips, cx } from "./ui";
import { useUi } from "./ui-context";

function showDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") {
    try {
      dialog.showModal();
      return;
    } catch {
      // Not connected yet, or an old engine. Fall back to a plain open dialog.
    }
  }
  dialog.setAttribute("open", "");
}

/** Where each open sheet sends focus when it closes, so a sheet opened from another sheet can inherit it. */
const RETURN_TARGETS = new WeakMap<HTMLDialogElement, HTMLElement | null>();

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") {
    dialog.close();
    return;
  }
  dialog.removeAttribute("open");
  dialog.dispatchEvent(new Event("close"));
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  // The body stays mounted until the dialog's close event. A sheet opened from this one (Settings
  // from the phone Menu) reads its opener in an effect, after React applied the switch, so the
  // button that opened it must still be in this dialog then. Otherwise focus lands on the page
  // body and Esc sends it to the big button instead of back to Menu.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.hasAttribute("open")) {
      const active = dialog.ownerDocument.activeElement as HTMLElement | null;
      // Opened from another sheet (Settings from the phone Menu), whose button is about to go away,
      // so return where that sheet would have returned.
      const opener = active?.closest?.("dialog") ?? null;
      returnTo.current =
        opener && opener !== dialog && RETURN_TARGETS.has(opener as HTMLDialogElement)
          ? (RETURN_TARGETS.get(opener as HTMLDialogElement) ?? null)
          : active && active !== dialog.ownerDocument.body
            ? active
            : null;
      RETURN_TARGETS.set(dialog, returnTo.current);
      showDialog(dialog);
    } else if (!open && dialog.hasAttribute("open")) {
      closeDialog(dialog);
    }
  }, [open]);

  const handleClose = () => {
    const target = returnTo.current;
    returnTo.current = null;
    const dialog = ref.current;
    if (dialog) RETURN_TARGETS.delete(dialog);
    setMounted(false);
    onClose();
    // Return focus to the opener unless something else already took it (for example the consent box
    // or another sheet). An opener that is gone hands focus to the big button.
    const doc = dialog?.ownerDocument;
    const active = doc?.activeElement ?? null;
    const lost = !active || active === doc?.body || (dialog?.contains(active) ?? false);
    if (!lost) return;
    if (target && target.isConnected) target.focus();
    else doc?.querySelector<HTMLElement>(".cu-big")?.focus();
  };

  return (
    <dialog
      ref={ref}
      className={cx("cu-sheet", wide && "cu-sheet-wide")}
      aria-labelledby={titleId}
      onClose={handleClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeDialog(e.currentTarget);
      }}
      lang="en"
    >
      {open || mounted ? (
        <div className="cu-sheet-inner">
          <div className="cu-sheet-head">
            <h2 id={titleId} className="cu-sheet-title">
              {title}
            </h2>
            <button
              type="button"
              className="cu-icon-btn"
              aria-label={UI.close}
              title={UI.close}
              onClick={() => {
                if (ref.current) closeDialog(ref.current);
              }}
            >
              <XIcon aria-hidden="true" />
            </button>
          </div>
          <div className="cu-sheet-body">{children}</div>
          {footer ? <div className="cu-sheet-foot">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

function NamesFields() {
  const { settings } = useSettings();
  const store = useSettingsStore();
  const helpId = useId();
  return (
    <fieldset className="cu-names">
      <legend className="cu-legend" lang="en">
        {UI.namesLabel}
      </legend>
      <p id={helpId} className="cu-help" lang="en">
        {UI.namesHelp}
      </p>
      {([0, 1, 2] as const).map((index) => (
        <div key={index} className="cu-field">
          <CappedInput
            id={`cu-name-${index}`}
            label={nameFormLabel(index + 1)}
            hideLabel
            value={settings.names[index]}
            cap={CAPS.listenerNames}
            describedBy={helpId}
            placeholder={NAME_PLACEHOLDERS[index]}
            onValue={(value) => store.setName(index, value)}
          />
        </div>
      ))}
    </fieldset>
  );
}

function LanguageChoices() {
  const { settings } = useSettings();
  const store = useSettingsStore();
  const options = CARD_LANGS.map((lang) => ({ value: lang, label: LANG_NAMES[lang], lang: tagOf(lang) }));
  return (
    <>
      <RadioChips<CardLang>
        big
        legend={UI.cardsIn}
        options={options}
        value={settings.cardLang}
        onChange={(cardLang) => store.update({ cardLang })}
      />
      <RadioChips<CardLang>
        big
        legend={UI.meetingLang}
        options={options}
        value={settings.meetingLang}
        onChange={(meetingLang) => store.update({ meetingLang })}
      />
    </>
  );
}

export function SetupSheet({ open, onClose, onContinue }: { open: boolean; onClose: () => void; onContinue: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={UI.setupTitle}
      footer={
        <button type="button" className="cu-btn cu-btn-primary cu-btn-wide" onClick={onContinue}>
          {UI.continue}
        </button>
      }
    >
      <ul className="cu-setup-lines">
        {UI.setupLines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <LanguageChoices />
      <NamesFields />
      <div className="cu-setup-limits">
        <p>{UI.aiCanBeWrong}</p>
        <p>{UI.adultsOnly}</p>
      </div>
    </Sheet>
  );
}

const ROUTE_OPTIONS: ReadonlyArray<{ value: SettingsRoute; label: string; help: string }> = [
  { value: "auto", label: UI.routeAuto, help: UI.routeAutoHelp },
  { value: "open_weights", label: UI.routeOpen, help: UI.routeOpenHelp },
  { value: "meta_api", label: UI.routeMeta, help: UI.routeMetaHelp },
];

function AdvancedSettings() {
  const session = useSession();
  const { settings } = useSettings();
  const store = useSettingsStore();
  const [open, setOpen] = useState(false);
  const id = useId();
  const live = liveRoutesConfigured(session.health);
  const known = session.health.state === "ok";
  const missing = (route: SettingsRoute) => known && route !== "auto" && !live.includes(route);
  const selected = ROUTE_OPTIONS.find((o) => o.value === settings.route) ?? ROUTE_OPTIONS[0];
  return (
    <div className="cu-advanced">
      <button type="button" className="cu-disclosure" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <GearIcon aria-hidden="true" />
        <span>{UI.advanced}</span>
      </button>
      <div id={id} hidden={!open} className="cu-advanced-body">
        <RadioChips<SettingsRoute>
          legend={UI.route}
          options={ROUTE_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
            disabled: missing(o.value),
            hint: missing(o.value) ? UI.routeMissing : undefined,
          }))}
          value={settings.route}
          onChange={(route) => store.update({ route })}
        />
        <p className="cu-help">{selected.help}</p>
        <label className="cu-check">
          <input
            type="checkbox"
            checked={settings.showTiming}
            onChange={(e) => store.update({ showTiming: e.target.checked })}
          />
          <span>{UI.showTiming}</span>
        </label>
      </div>
    </div>
  );
}

function HotkeySettings() {
  const session = useSession();
  const ctl = useController();
  const hotkey = session.desktop.hotkey;
  if (!session.desktop.present) return null;
  return (
    <div className="cu-hotkey-settings">
      <RadioChips<DesktopHotkeyPreset>
        legend={UI.hotkey}
        options={DESKTOP_HOTKEY_PRESETS.map((preset) => ({ value: preset, label: acceleratorLabel(preset) }))}
        value={hotkey?.accelerator ?? DESKTOP_HOTKEY_PRESETS[0]}
        onChange={(preset) => ctl.setHotkey(preset)}
      />
      <p className="cu-help">{UI.hotkeyHelp}</p>
      {hotkey && !hotkey.registered ? (
        <p className="cu-help cu-help-warn" role="status">
          {hotkey.error ?? hotkeyTaken(acceleratorLabel(hotkey.accelerator ?? DESKTOP_HOTKEY_PRESETS[0]))}
        </p>
      ) : hotkey?.error ? (
        // Why the app started on another preset (taken, or AltGr+C types a character here).
        <p className="cu-help">{hotkey.error}</p>
      ) : null}
    </div>
  );
}

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings } = useSettings();
  const store = useSettingsStore();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={UI.settings}
      footer={
        <button type="button" className="cu-btn cu-btn-primary cu-btn-wide" onClick={onClose}>
          {UI.done}
        </button>
      }
    >
      <LanguageChoices />
      <NamesFields />
      <RadioChips
        legend={UI.defaultWindow}
        options={([30, 60, 120] as const).map((w) => ({ value: w, label: windowLabel(w) }))}
        value={settings.windowSec}
        onChange={(windowSec) => store.update({ windowSec })}
      />
      <RadioChips
        legend={UI.textSize}
        options={TEXT_SIZES.map((size) => ({ value: size, label: textSizeLabel(size) }))}
        value={settings.textSize}
        onChange={(textSize) => store.update({ textSize })}
      />
      <HotkeySettings />
      <AdvancedSettings />
      <p className="cu-help">{UI.settingsSaved}</p>
    </Sheet>
  );
}

export function PrivacySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={PRIVACY.title} wide>
      <PrivacyContent headingLevel={3} />
    </Sheet>
  );
}

export function SourceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={UI.sourceTitle}
      footer={
        <button type="button" className="cu-btn cu-btn-primary cu-btn-wide" onClick={onClose}>
          {UI.done}
        </button>
      }
    >
      <SourceStep inSheet />
    </Sheet>
  );
}

export function HistorySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={UI.thisSession}>
      <History preferShare titleId="cu-history-sheet-h" />
    </Sheet>
  );
}

export function MenuSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ui = useUi();
  return (
    <Sheet open={open} onClose={onClose} title={UI.menu}>
      <div className="cu-menu">
        <button type="button" className="cu-btn cu-btn-secondary cu-btn-wide" onClick={() => ui.openSheet("settings")}>
          <GearIcon aria-hidden="true" />
          <span>{UI.settings}</span>
        </button>
        <button type="button" className="cu-btn cu-btn-secondary cu-btn-wide" onClick={() => ui.openSheet("privacy")}>
          <ShieldCheckIcon aria-hidden="true" />
          <span>{UI.howAudioHandled}</span>
        </button>
        {ui.sources.length > 1 ? (
          <button type="button" className="cu-btn cu-btn-secondary cu-btn-wide" onClick={() => ui.openSheet("source")}>
            <span>{UI.changeSource}</span>
          </button>
        ) : null}
        <HintInput id="cu-hint-menu" />
        <section className="cu-menu-how">
          <h3 className="cu-section-title">{UI.howItWorks}</h3>
          <ol className="cu-steps">
            {UI.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
        <div className="cu-menu-foot">
          <p>{UI.phoneOnlyRoom}</p>
          <p>{UI.aiCanBeWrong}</p>
          <p>{UI.adultsOnly}</p>
          <p className="cu-built-with">{UI.builtWith}</p>
        </div>
      </div>
    </Sheet>
  );
}
