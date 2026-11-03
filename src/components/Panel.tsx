// The Panel (ux-spec 4). One component on every surface. The main page, the floating window, the
// phone and the Windows app all render this, in the same order. Status row, memory bar, card
// area (ask and say first), then the action bar with the window chips and the big button.
import { Component, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CARD_LANGS, type CardLang } from "@/lib/card/schema";
import { buttonMode, type ButtonMode } from "@/lib/client/button-mode";
import {
  CAPTURE_ERROR_COPY,
  LANG_SHORT,
  SOURCE_LABELS,
  SOURCE_TILES,
  UI,
  catchUpName,
  collectingLabel,
  earlierLabel,
  hotkeyHint,
  hotkeyTaken,
  listeningLabel,
  memoryLabel,
  noticeText,
  partialLabel,
  quietHint,
  sendingLabel,
  sendsLast,
  sourceChipName,
  sourceLostLabel,
  windowLabel,
} from "@/lib/client/copy";
import { acceleratorLabel, formatMemory } from "@/lib/client/format";
import { WEB_HOTKEY, eventEpochMs } from "@/lib/client/hotkey";
import {
  useController,
  useLevel,
  useReducedMotion,
  useSession,
  useSettings,
  useSettingsStore,
} from "@/lib/client/hooks";
import { headsUpText, tagOf } from "@/lib/client/local";
import { planRoute } from "@/lib/client/route";
import { currentCard } from "@/lib/client/session-state";
import { LIMITS } from "@/lib/protocol";
import { CardView } from "./CardView";
import {
  ArrowUUpLeftIcon,
  ArrowsOutSimpleIcon,
  CaretDownIcon,
  CheckIcon,
  InfoIcon,
  ListIcon,
  PauseIcon,
  WarningIcon,
  XIcon,
} from "./icons";
import { EmptyState } from "./Landing";
import { RequestView } from "./RequestView";
import { CopyButton, Notice, RadioChips, cx } from "./ui";
import { CONSENT_ID, useUi, type PanelSurface } from "./ui-context";

const WINDOW_OPTIONS = [30, 60, 120] as const;

function isCompactSurface(surface: PanelSurface): boolean {
  return surface === "pip" || surface === "app-compact";
}

/** True when the element shows a keyboard focus ring (not after a mouse click). */
function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false; // an engine without the selector
  }
}

function LangSelect({ surface }: { surface: PanelSurface }) {
  const { settings } = useSettings();
  const store = useSettingsStore();
  const id = `cu-lang-${surface}`;
  return (
    <span className="cu-lang-select">
      <label htmlFor={id} className="sr-only" lang="en">
        {UI.cardLanguage}
      </label>
      <select
        id={id}
        value={settings.cardLang}
        onChange={(e) => store.update({ cardLang: e.target.value as CardLang })}
        lang={tagOf(settings.cardLang)}
      >
        {CARD_LANGS.map((lang) => (
          <option key={lang} value={lang} lang={tagOf(lang)}>
            {LANG_SHORT[lang]}
          </option>
        ))}
      </select>
    </span>
  );
}

function LevelMini() {
  const level = useLevel();
  if (level.soundOk) {
    return (
      <span className="cu-sound-ok" lang="en">
        <CheckIcon aria-hidden="true" weight="bold" />
        {UI.soundOk}
      </span>
    );
  }
  const rms = level.reading?.rms ?? 0;
  const value = Math.min(1, Math.sqrt(rms) * 1.6);
  return (
    <span className="cu-meter" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="cu-meter-bar" data-on={value > (i + 0.5) / 5 || undefined} />
      ))}
    </span>
  );
}

function MemoryClock() {
  const level = useLevel();
  return (
    <span className="cu-mem" lang="en">
      <span className="cu-tabular">{formatMemory(level.reading?.memorySec ?? 0)}</span>
      <span className="cu-mem-word"> {UI.inMemory}</span>
      <span className="cu-mem-saved"> · {UI.notSaved}</span>
    </span>
  );
}

function StatusRow({ surface }: { surface: PanelSurface }) {
  const session = useSession();
  const { settings } = useSettings();
  const ctl = useController();
  const ui = useUi();
  const capture = session.capture;
  const plan = planRoute(settings.route, session.health, session.mockParam);
  const listening = capture.state === "listening";
  const short = isCompactSurface(surface) || surface === "phone";
  const canPickSource =
    listening &&
    capture.source !== "sample" &&
    (surface === "web" || surface === "app-full" || (surface === "phone" && ui.sources.length > 1));

  let text: string = UI.notListening;
  let dot: "on" | "off" | "paused" | "problem" = "off";
  if (capture.state === "starting") text = UI.starting;
  if (listening) {
    text = short || canPickSource ? UI.listening : listeningLabel(capture.source);
    dot = "on";
  }
  if (capture.state === "paused") {
    dot = capture.reason === "source_lost" ? "problem" : "paused";
    text = capture.reason === "source_lost" ? sourceLostLabel(capture.source) : UI.pausedCleared;
  }
  if (capture.state === "error") dot = "problem";

  return (
    <div className="cu-status" data-drag={surface === "app-compact" || undefined}>
      <span className="cu-dot" data-state={dot} aria-hidden="true" />
      <span className="cu-status-text" role="status" lang="en">
        {text}
      </span>
      {canPickSource ? (
        <>
          <span className="cu-status-sep" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            className="cu-source-chip"
            onClick={() => ui.checkSource()}
            aria-label={sourceChipName(SOURCE_LABELS[capture.source])}
            lang="en"
          >
            {SOURCE_LABELS[capture.source]}
          </button>
        </>
      ) : null}
      <span className="cu-status-spacer" />
      {plan.route === "mock" ? (
        <span className="cu-badge cu-badge-mock" lang="en">
          {UI.mock}
        </span>
      ) : null}
      {listening && capture.source === "sample" ? (
        <span className="cu-badge cu-badge-sample" lang="en">
          {UI.sample}
        </span>
      ) : null}
      <LangSelect surface={surface} />
      {surface === "phone" ? (
        <button
          type="button"
          className="cu-icon-btn"
          onClick={() => ui.openSheet("menu")}
          aria-label={UI.menu}
          title={UI.menu}
          lang="en"
        >
          <ListIcon aria-hidden="true" />
        </button>
      ) : null}
      {surface === "app-compact" ? (
        <>
          <button
            type="button"
            className="cu-icon-btn"
            onClick={() => ctl.setDesktopView("full")}
            aria-label={UI.fullView}
            title={UI.fullView}
            lang="en"
          >
            <ArrowsOutSimpleIcon aria-hidden="true" />
          </button>
          <button
            type="button"
            className="cu-icon-btn"
            onClick={() => ctl.hideWindow()}
            aria-label={UI.hidePanel}
            title={UI.hidePanel}
            lang="en"
          >
            <XIcon aria-hidden="true" />
          </button>
        </>
      ) : null}
    </div>
  );
}

/** The last 2 minutes, filled from the right as memory grows, with the send window outlined. */
function MemoryBar() {
  const level = useLevel();
  const session = useSession();
  const { settings } = useSettings();
  const capture = session.capture;
  const listening = capture.state === "listening";
  const memorySec = listening ? (level.reading?.memorySec ?? 0) : 0;
  const request = session.core.request;
  const sending = request.phase === "busy" && request.sentSec !== null;
  const pct = (sec: number) => `${Math.max(0, Math.min(100, (sec / LIMITS.memorySec) * 100))}%`;
  const label = `${UI.memoryBarLabel}. ${memoryLabel(formatMemory(memorySec))}. ${sendsLast(settings.windowSec)}.`;
  return (
    <div className="cu-membar" lang="en">
      <div className="cu-membar-track" role="img" aria-label={label}>
        <span className="cu-membar-fill" style={{ width: pct(memorySec) }} />
        <span className="cu-membar-window" style={{ width: pct(settings.windowSec) }} />
        {sending ? <span className="cu-membar-lit" style={{ width: pct(request.sentSec ?? 0) }} /> : null}
      </div>
      {sending ? (
        <span className="cu-membar-label">
          {request.partial ? partialLabel(request.sentSec ?? 0) : sendingLabel(request.sentSec ?? 0)}
        </span>
      ) : listening ? (
        <>
          <MemoryClock />
          {capture.endedAt === undefined ? <LevelMini /> : null}
        </>
      ) : null}
    </div>
  );
}

function PanelNotices({ surface }: { surface: PanelSurface }) {
  const session = useSession();
  const level = useLevel();
  const ui = useUi();
  const ctl = useController();
  const capture = session.capture;
  const notice = session.notice;
  const out: React.ReactNode[] = [];

  if (session.unavailable && !notice) {
    out.push(
      <Notice key="unavailable" tone="warn" icon={<WarningIcon aria-hidden="true" />}>
        {UI.unavailable}
      </Notice>,
    );
  }
  if (notice) {
    // Screen readers hear this through the live region (the controller announces it).
    const text = noticeText(notice.kind, notice.secondsLeft ?? 1);
    out.push(
      <Notice
        key={`notice-${notice.seq}`}
        tone="info"
        icon={<InfoIcon aria-hidden="true" />}
        actions={
          <button type="button" className="cu-btn cu-btn-quiet cu-btn-small" onClick={() => ctl.clearNotice()}>
            {UI.gotIt}
          </button>
        }
      >
        {text}
      </Notice>,
    );
  }
  if (capture.state === "error") {
    out.push(
      <Notice key="capture-error" tone="warn" icon={<WarningIcon aria-hidden="true" />}>
        {CAPTURE_ERROR_COPY[capture.code]}
      </Notice>,
    );
  }
  if (capture.state === "paused" && capture.reason === "source_lost") {
    out.push(
      <Notice key="source-lost" tone="warn" icon={<WarningIcon aria-hidden="true" />}>
        {sourceLostLabel(capture.source)}
      </Notice>,
    );
  }
  if (capture.state === "paused" && capture.reason === "interrupted") {
    out.push(
      <Notice key="interrupted" tone="info" icon={<InfoIcon aria-hidden="true" />}>
        {UI.interrupted}
      </Notice>,
    );
  }
  if (capture.state === "listening" && level.quiet && capture.source !== "sample") {
    out.push(
      <Notice
        key="quiet"
        tone="warn"
        icon={<WarningIcon aria-hidden="true" />}
        actions={
          surface !== "pip" ? (
            <button type="button" className="cu-btn cu-btn-quiet cu-btn-small" onClick={() => ui.checkSource()}>
              {UI.checkSource}
            </button>
          ) : null
        }
      >
        {quietHint(capture.source)}
      </Notice>,
    );
  }
  if (out.length === 0) return null;
  return <div className="cu-notices">{out}</div>;
}

function CardArea({ surface }: { surface: PanelSurface }) {
  const session = useSession();
  const ref = useRef<HTMLDivElement>(null);
  const card = currentCard(session.core);
  const request = session.core.request;
  const busy = request.phase === "busy";
  const busyId = busy ? request.pressId : null;
  const currentId = session.core.currentId;

  // A new press and a new card start at the top, so Asked you and the stall line are never cut off.
  // A keyboard user who pressed a card control (a language chip, Further back) keeps it in view
  // instead, because focus stays on it and a focus ring scrolled out of sight is lost.
  useLayoutEffect(() => {
    const area = ref.current;
    if (!area) return;
    // Not instanceof, the floating window's elements come from another realm.
    const active = area.ownerDocument.activeElement;
    if (active && active !== area && area.contains(active) && isFocusVisible(active)) {
      if (typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
      return;
    }
    area.scrollTop = 0;
    // On phones and short windows the page scrolls instead, so bring the panel top back into view.
    const panel = area.closest<HTMLElement>(".cu-panel");
    if (panel && area.getBoundingClientRect().top < 0 && typeof panel.scrollIntoView === "function") {
      panel.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }, [busyId, currentId]);

  return (
    <div className="cu-card-area" data-busy={busy || undefined} ref={ref}>
      <PanelNotices surface={surface} />
      <RequestView request={request} />
      {card ? (
        <div className={cx("cu-card-wrap", busy && "cu-card-dim")}>
          <CardView card={card} interactive compact={isCompactSurface(surface)} />
        </div>
      ) : request.phase === "idle" ? (
        <EmptyState surface={surface} />
      ) : null}
    </div>
  );
}

/**
 * The People here know tick, with the heads-up line folded behind Show heads-up so the card area
 * keeps its room on phones and short screens. The line names the most a press can send.
 */
function ConsentRow({ compact }: { compact: boolean }) {
  const session = useSession();
  const { settings } = useSettings();
  const ctl = useController();
  const [open, setOpen] = useState(false);
  const blockId = useId();
  const line = headsUpText(settings.meetingLang);
  return (
    <div className="cu-consent" data-compact={compact || undefined}>
      <div className="cu-consent-row">
        <label className="cu-check">
          <input
            id={CONSENT_ID}
            type="checkbox"
            checked={session.consent}
            onChange={(e) => ctl.setConsent(e.target.checked)}
          />
          <span lang="en">{UI.consentLabel}</span>
        </label>
        <button
          type="button"
          className="cu-link-btn cu-heads-up-toggle"
          aria-expanded={open}
          aria-controls={blockId}
          onClick={() => setOpen((v) => !v)}
          lang="en"
        >
          <CaretDownIcon aria-hidden="true" className="cu-disclosure-caret" />
          <span>{open ? UI.hideHeadsUp : UI.showHeadsUp}</span>
        </button>
      </div>
      <div id={blockId} className="cu-heads-up-block" hidden={!open}>
        <div className="cu-consent-head">
          <span className="cu-consent-title" lang="en">
            {UI.tellPeople}
          </span>
          <CopyButton text={line} label={UI.copyForChat} compact />
        </div>
        <p className="cu-heads-up" lang={tagOf(settings.meetingLang)}>
          {line}
        </p>
      </div>
    </div>
  );
}

function WindowChips() {
  const { settings } = useSettings();
  const store = useSettingsStore();
  return (
    <RadioChips
      legend={UI.howMuch}
      hideLegend
      className="cu-window-chips"
      options={WINDOW_OPTIONS.map((w) => ({ value: w, label: windowLabel(w) }))}
      value={settings.windowSec}
      onChange={(windowSec) => store.update({ windowSec })}
    />
  );
}

function hotkeyText(surface: PanelSurface, accelerator: string | null): string {
  if (surface === "phone") return "";
  if (surface === "app-compact" || surface === "app-full") {
    return accelerator ? hotkeyHint(acceleratorLabel(accelerator), true) : "";
  }
  return WEB_HOTKEY.label;
}

function BigButton({ surface }: { surface: PanelSurface }) {
  const session = useSession();
  const level = useLevel();
  const ctl = useController();
  const ui = useUi();
  const { settings } = useSettings();
  const reducedMotion = useReducedMotion();
  const pressAt = useRef<number | null>(null);
  const request = session.core.request;
  const mode: ButtonMode = buttonMode({
    request,
    capture: session.capture,
    memorySec: level.reading?.memorySec ?? 0,
    lastLiveSource: session.lastLiveSource,
  });
  const reasonId = `cu-btn-reason-${surface}`;
  // On phones the reason rides inside the button, so the fixed thumb zone stays one button tall.
  const reasonInside = surface === "phone";
  const desktopHotkey = session.desktop.hotkey;
  const accelerator = desktopHotkey?.registered ? desktopHotkey.accelerator : null;
  const hint = hotkeyText(surface, accelerator);
  const needsConsent = mode.kind === "start" && !session.consent;
  const pulseSeq = session.sample?.pulseSeq ?? 0;
  const pulse = mode.kind === "catch" && pulseSeq > 0 && !reducedMotion ? (pulseSeq % 2 ? "a" : "b") : undefined;

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    pressAt.current = eventEpochMs(e.nativeEvent);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") pressAt.current = eventEpochMs(e.nativeEvent);
  };

  const onClick = () => {
    const recorded = pressAt.current;
    pressAt.current = null;
    const now = Date.now();
    const at = recorded !== null && now - recorded < 2_000 ? recorded : now;
    switch (mode.kind) {
      case "catch":
        ctl.catchUp(at);
        return;
      case "cancel":
        // A double click on Catch up must not cancel the press it just made. Redos keep the first
        // press time for their card, so this counts from when the attempt started.
        if (request.phase === "busy" && now - request.startedAt > 700) ctl.cancel();
        return;
      case "start":
        if (mode.action === "resume" && session.consent && ctl.resume()) return;
        ui.startListening();
        return;
      default:
        return;
    }
  };

  let main: string;
  let sub: string | null = null;
  let name: string | undefined;
  let disabled = false;
  let reason: string | null = null;
  switch (mode.kind) {
    case "catch":
      main = UI.catchUp;
      sub = hint ? `${sendsLast(settings.windowSec)} · ${hint}` : sendsLast(settings.windowSec);
      name = catchUpName(settings.windowSec);
      break;
    case "cancel":
      main = UI.cancel;
      sub = UI.escHint;
      break;
    case "warming":
      main = collectingLabel(mode.secondsLeft);
      disabled = true;
      reason = UI.warmingReason;
      break;
    case "starting":
      main = UI.starting;
      disabled = true;
      break;
    case "start":
      main = mode.label;
      sub = SOURCE_TILES[ui.source].title;
      if (needsConsent) {
        disabled = true;
        reason = UI.consentFirst;
      }
      break;
  }

  const inlineReason = reasonInside && reason !== null;
  return (
    <div className="cu-big-wrap">
      <button
        type="button"
        className="cu-big"
        data-mode={mode.kind}
        data-pulse={pulse}
        aria-disabled={disabled || undefined}
        aria-describedby={reason ? reasonId : undefined}
        aria-keyshortcuts={mode.kind === "catch" ? (accelerator ?? WEB_HOTKEY.aria) : mode.kind === "cancel" ? "Escape" : undefined}
        // With the reason inside, the name stays the label and the reason is only the description.
        aria-label={inlineReason ? main : name}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onClick={onClick}
        lang="en"
      >
        <span className="cu-big-main">{main}</span>
        {inlineReason ? (
          <span id={reasonId} className="cu-big-sub">
            {reason}
          </span>
        ) : sub ? (
          <span className="cu-big-sub">{sub}</span>
        ) : null}
      </button>
      {reason && !inlineReason ? (
        <p id={reasonId} className="cu-big-reason" lang="en">
          {reason}
        </p>
      ) : null}
    </div>
  );
}

function SecondaryRow({ surface }: { surface: PanelSurface }) {
  const session = useSession();
  const ctl = useController();
  const ui = useUi();
  const capture = session.capture;
  const listening = capture.state === "listening";
  const hotkey = session.desktop.hotkey;
  const showHotkeyProblem = session.desktop.present && hotkey !== null && !hotkey.registered;
  const items: React.ReactNode[] = [];

  if (listening) {
    items.push(
      <button key="pause" type="button" className="cu-text-btn" onClick={() => ctl.pause()} lang="en">
        <PauseIcon aria-hidden="true" weight="fill" />
        <span>{UI.pause}</span>
      </button>,
    );
  }
  if (surface === "phone" && session.core.cards.length > 0) {
    // Earlier opens this session's cards. With none yet it only takes room from the card area.
    items.push(
      <button key="earlier" type="button" className="cu-text-btn" onClick={() => ui.openSheet("history")} lang="en">
        {earlierLabel(session.core.cards.length)}
      </button>,
    );
  }
  if (surface === "pip") {
    items.push(
      <button key="back" type="button" className="cu-text-btn" onClick={() => ctl.closePip()} lang="en">
        <ArrowUUpLeftIcon aria-hidden="true" />
        <span>{UI.backToTab}</span>
      </button>,
    );
  }
  if (items.length === 0 && !showHotkeyProblem) return null;
  return (
    <div className="cu-secondary">
      {items}
      {showHotkeyProblem ? (
        <p className="cu-secondary-note" lang="en">
          {hotkey?.error ?? hotkeyTaken(acceleratorLabel(hotkey?.accelerator ?? "Control+Alt+C"))}
        </p>
      ) : null}
    </div>
  );
}

function ActionBar({ surface }: { surface: PanelSurface }) {
  const session = useSession();
  const capture = session.capture;
  const live = capture.state === "listening" || capture.state === "starting";
  if (surface === "phone") {
    // The fixed thumb zone holds the big button alone, so the card keeps the screen. The tick, the
    // window chips, Pause and Earlier scroll with the content, in the same order, right above it.
    return (
      <>
        <div className="cu-phone-tools">
          {!live ? <ConsentRow compact={false} /> : null}
          <WindowChips />
          <SecondaryRow surface={surface} />
        </div>
        <div className="cu-action-bar">
          <BigButton surface={surface} />
        </div>
      </>
    );
  }
  return (
    <div className="cu-action-bar">
      {!live ? <ConsentRow compact={isCompactSurface(surface)} /> : null}
      {surface !== "pip" ? <WindowChips /> : null}
      <BigButton surface={surface} />
      <SecondaryRow surface={surface} />
    </div>
  );
}

function LiveRegion() {
  const session = useSession();
  const a = session.core.announcement;
  const parts = a ? (
    <span key={a.seq}>
      {a.parts.map((part, i) => (
        <span key={i} lang={part.lang}>
          {part.text}{" "}
        </span>
      ))}
    </span>
  ) : null;
  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {a && !a.assertive ? parts : null}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {a && a.assertive ? parts : null}
      </div>
    </>
  );
}

/**
 * Keeps keyboard focus in the panel. When the control that had focus goes away (Close, Esc in the
 * card, Pause, Got it, or Further back once there is nothing older), focus moves to the big button
 * instead of falling to the page body. getSnapshotBeforeUpdate reads the focused element before
 * React removes anything, so this works without focus events (which a background window skips).
 */
class FocusKeeper extends Component<{ panel: RefObject<HTMLElement | null>; version: unknown }> {
  getSnapshotBeforeUpdate(): Element | null {
    const panel = this.props.panel.current;
    const active = panel?.ownerDocument.activeElement ?? null;
    return panel && active && active !== panel && panel.contains(active) ? active : null;
  }

  componentDidUpdate(_props: unknown, _state: unknown, focused: Element | null): void {
    const panel = this.props.panel.current;
    if (!focused || focused.isConnected || !panel) return;
    const doc = panel.ownerDocument;
    const active = doc.activeElement;
    if (active && active !== doc.body) return; // focus already went somewhere on purpose
    panel.querySelector<HTMLElement>(".cu-big")?.focus();
  }

  render(): null {
    return null;
  }
}

export function Panel({ surface }: { surface: PanelSurface }) {
  const session = useSession();
  const ref = useRef<HTMLElement>(null);
  return (
    <section ref={ref} className="cu-panel" data-surface={surface} aria-label={UI.appName} lang="en">
      <StatusRow surface={surface} />
      <MemoryBar />
      <CardArea surface={surface} />
      <ActionBar surface={surface} />
      <LiveRegion />
      <FocusKeeper panel={ref} version={session} />
    </section>
  );
}

/** Shown in the tab while the Panel floats. */
export function PipPlaceholder() {
  const ctl = useController();
  return (
    <section className="cu-panel cu-panel-placeholder" aria-label={UI.appName} lang="en">
      <p>{UI.pipOpenNote}</p>
      <button type="button" className="cu-btn cu-btn-secondary" onClick={() => ctl.closePip()}>
        <ArrowUUpLeftIcon aria-hidden="true" />
        <span>{UI.bringBack}</span>
      </button>
    </section>
  );
}

