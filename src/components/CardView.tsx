// The card in panic order (ux-spec 2-8 and 3). Ask banner, say block, hearing note, summary,
// facts, What they said, receipt, then Further back and the language chips on the latest card.
// Card labels come in the card language, app chrome stays English, and every text node has lang.
import { useId, useState } from "react";
import { nextWindow } from "@/lib/audio/types";
import { CARD_LANGS, routeLabelOf, type Card, type CardLang, type Fact, type FactKind } from "@/lib/card/schema";
import {
  FACT_KIND_NAMES,
  LANG_SHORT,
  UI,
  cardHeading,
  cardWindow,
  furtherBackLabel,
  nextCardIn,
  savedRunLabel,
  timingLine,
} from "@/lib/client/copy";
import { clockOfIso, formatRunDate } from "@/lib/client/format";
import { useController, useNow, useSession, useSettings, useSettingsStore } from "@/lib/client/hooks";
import { label, plainTextOf, receiptOf, scriptLang, tagOf } from "@/lib/client/local";
import { canReuseClip, hasMoreToSend, isLatestCard } from "@/lib/client/session-state";
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  AtIcon,
  BookOpenTextIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CheckCircleIcon,
  HandWavingIcon,
  HashIcon,
  ListChecksIcon,
  MapPinIcon,
  QuestionIcon,
  QuotesIcon,
  SparkleIcon,
  UserCircleIcon,
  UsersThreeIcon,
  WarningIcon,
  XIcon,
} from "./icons";
import { CopyButton, VisuallyHidden, cx } from "./ui";
import { useUi } from "./ui-context";

const FACT_ICONS: Record<FactKind, typeof HashIcon> = {
  name: UserCircleIcon,
  date: CalendarBlankIcon,
  number: HashIcon,
  place: MapPinIcon,
  term: BookOpenTextIcon,
  task: ListChecksIcon,
};

function cardTag(card: Card): string {
  return tagOf(card.meta.cardLang);
}

/**
 * Han-only text (Japanese dates, numbers and kanji names have no kana) reads as Japanese when the
 * card or its say line is Japanese, or when people around usually speak Japanese.
 */
function useHanAsJa(card: Card): boolean {
  const { settings } = useSettings();
  return card.meta.cardLang === "ja" || card.say?.lang === "ja" || settings.meetingLang === "ja";
}

function AskBanner({ card, showQuote }: { card: Card; showQuote: boolean }) {
  const lang = card.meta.cardLang;
  const tag = cardTag(card);
  const hanAsJa = useHanAsJa(card);
  const { to, text, by } = card.ask;
  if (to === "none") {
    return (
      <p className="cu-ask-none" lang={tag}>
        <CheckCircleIcon aria-hidden="true" />
        <span>{label(lang, "none")}</span>
      </p>
    );
  }
  const Icon = to === "you" ? HandWavingIcon : to === "room" ? UsersThreeIcon : AtIcon;
  const key = to === "you" ? "askedYou" : to === "room" ? "room" : "mentioned";
  const quoteTag = card.quote ? scriptLang(card.quote, hanAsJa) : null;
  return (
    <div className={cx("cu-ask", to === "you" ? "cu-ask-you" : "cu-ask-neutral")}>
      <p className="cu-ask-label" lang={tag}>
        <Icon aria-hidden="true" weight={to === "you" ? "fill" : "regular"} />
        <span>{label(lang, key)}</span>
      </p>
      {text ? (
        <p className="cu-ask-text" lang={tag}>
          {text}
        </p>
      ) : null}
      {by ? (
        <p className="cu-ask-by">
          <UserCircleIcon aria-hidden="true" />
          <span lang={scriptLang(by, hanAsJa)}>{by}</span>
        </p>
      ) : null}
      {showQuote && card.quote && quoteTag !== tag ? (
        <p className="cu-ask-quote" lang={quoteTag ?? undefined}>
          <QuotesIcon aria-hidden="true" />
          <span>{card.quote}</span>
        </p>
      ) : null}
    </div>
  );
}

function SayBlock({ card, compact }: { card: Card; compact: boolean }) {
  const say = card.say;
  if (!say) return null;
  const lang = card.meta.cardLang;
  const tag = cardTag(card);
  return (
    <section className="cu-say" aria-label={label(lang, card.ask.to === "none" ? "sayNone" : "sayAsked")}>
      <div className="cu-say-head">
        <span className="cu-say-label" lang={tag}>
          {label(lang, card.ask.to === "none" ? "sayNone" : "sayAsked")}
        </span>
        <span className="cu-ai-tag" lang={tag}>
          <SparkleIcon aria-hidden="true" />
          {label(lang, "aiTag")}
        </span>
      </div>
      <p className="cu-say-text" lang={tagOf(say.lang)}>
        {say.text}
      </p>
      {say.gloss ? (
        <p className="cu-say-gloss" lang={tag}>
          <span className="cu-gloss-label">{label(lang, "glossLabel")}</span> <span>{say.gloss}</span>
        </p>
      ) : null}
      <div className="cu-say-actions">
        <CopyButton text={say.text} label={UI.copyLine} compact={compact} />
      </div>
    </section>
  );
}

function FactItem({ fact, card }: { fact: Fact; card: Card }) {
  const Icon = FACT_ICONS[fact.kind];
  const lang = card.meta.cardLang;
  const tag = cardTag(card);
  const hanAsJa = useHanAsJa(card);
  // Dates and numbers are written in the card language, so they take its tag.
  const textLang = fact.kind === "date" || fact.kind === "number" ? tag : scriptLang(fact.text, hanAsJa);
  return (
    <li className="cu-fact" data-unsure={fact.unsure ? "true" : undefined}>
      <Icon aria-hidden="true" className="cu-fact-icon" />
      <VisuallyHidden lang="en">{FACT_KIND_NAMES[fact.kind]}, </VisuallyHidden>
      <span className="cu-fact-main">
        <span className="cu-fact-text" lang={textLang}>
          {fact.text}
        </span>
        {fact.unsure ? (
          <span className="cu-fact-check" lang={tag}>
            <QuestionIcon aria-hidden="true" weight="bold" />
            {label(lang, "unsure")}
          </span>
        ) : null}
      </span>
      {fact.note ? (
        <span className="cu-fact-note" lang={tag}>
          {fact.note}
        </span>
      ) : null}
    </li>
  );
}

function Evidence({ card }: { card: Card }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const hanAsJa = useHanAsJa(card);
  const quote = card.quote;
  const transcript = card.meta.transcript;
  if (!quote && !transcript) return null;
  const lang = card.meta.cardLang;
  return (
    <div className="cu-evidence">
      <button
        type="button"
        className="cu-disclosure"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <CaretDownIcon aria-hidden="true" className="cu-disclosure-caret" />
        <span lang={cardTag(card)}>{label(lang, "evidence")}</span>
      </button>
      <div id={id} hidden={!open} className="cu-evidence-body">
        {quote ? (
          <blockquote className="cu-quote" lang={scriptLang(quote, hanAsJa)}>
            {quote}
          </blockquote>
        ) : null}
        {transcript ? (
          <>
            <p className="cu-evidence-label" lang="en">
              {UI.transcript}
            </p>
            <p className="cu-transcript" lang={scriptLang(transcript, hanAsJa)}>
              {transcript}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Receipt({ card }: { card: Card }) {
  const { settings } = useSettings();
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  return (
    <div className="cu-receipt" lang="en">
      <p>{receiptOf(card, timeZone)}</p>
      {settings.showTiming ? <p className="cu-timing">{timingLine(card.meta.ms)}</p> : null}
    </div>
  );
}

function RedoRow({ card }: { card: Card }) {
  const ctl = useController();
  const session = useSession();
  const store = useSettingsStore();
  const ui = useUi();
  const held = session.core.heldUntil !== null;
  const now = useNow(held);
  const reusable = canReuseClip(session.core, now);
  const busy = session.core.request.phase === "busy";
  // Further back only when there is something older to send. A partial card already holds all there was.
  const next = hasMoreToSend(session.core, card) ? nextWindow(card.meta.windowSec) : null;
  const [pickedNext, setPickedNext] = useState<CardLang | null>(null);
  const isSample = card.meta.source === "sample";

  const onLang = (lang: CardLang) => {
    if (lang === card.meta.cardLang || busy) return;
    if (reusable) {
      ctl.redoLanguage(lang);
      return;
    }
    store.update({ cardLang: lang });
    setPickedNext(lang);
  };

  return (
    <div className="cu-redo">
      {next && reusable ? (
        <button
          type="button"
          className={cx("cu-btn", card.earlier ? "cu-btn-secondary cu-btn-wide" : "cu-btn-quiet")}
          onClick={() => ctl.furtherBack()}
          aria-disabled={busy || undefined}
          lang="en"
        >
          <ArrowCounterClockwiseIcon aria-hidden="true" />
          <span>{furtherBackLabel(next)}</span>
        </button>
      ) : null}
      {card.earlier ? (
        <p className="cu-redo-note" lang="en">
          {UI.startsMidThought}
        </p>
      ) : null}
      <div className="cu-lang-chips" role="group" aria-label={UI.cardLanguage}>
        {CARD_LANGS.map((lang) => (
          <button
            key={lang}
            type="button"
            className="cu-chip-btn"
            aria-pressed={lang === card.meta.cardLang}
            aria-disabled={busy || undefined}
            onClick={() => onLang(lang)}
            lang={tagOf(lang)}
          >
            {LANG_SHORT[lang]}
          </button>
        ))}
      </div>
      {pickedNext && !reusable ? (
        <p className="cu-redo-note" lang="en" role="status">
          {nextCardIn(pickedNext)}
        </p>
      ) : null}
      {isSample ? (
        <button type="button" className="cu-btn cu-btn-secondary cu-btn-wide" onClick={() => ui.useReal()} lang="en">
          {UI.useReal}
        </button>
      ) : null}
    </div>
  );
}

export function CardView({
  card,
  interactive,
  compact = false,
  headingLevel = 2,
}: {
  card: Card;
  /** The card in the card area, with Copy card, Close, Further back and the language chips. */
  interactive: boolean;
  compact?: boolean;
  headingLevel?: 2 | 3;
}) {
  const ctl = useController();
  const session = useSession();
  const ui = useUi();
  const headingId = useId();
  const lang = card.meta.cardLang;
  const tag = cardTag(card);
  const clock = clockOfIso(card.meta.pressedAt);
  const latest = interactive && isLatestCard(session.core, card);
  const unformatted = card.meta.unformatted === true;
  const hanAsJa = useHanAsJa(card);
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <article
      className="cu-card"
      aria-labelledby={headingId}
      data-ask={card.ask.to}
      data-heard={card.heard}
      data-compact={compact || undefined}
    >
      <header className="cu-card-head">
        <Heading id={headingId} className="cu-card-title" lang="en">
          {cardHeading(clock)}
          <span className="cu-card-window"> · {cardWindow(card.meta.windowSec, card.meta.sentSec)}</span>
        </Heading>
        <div className="cu-card-badges" lang="en">
          {card.meta.route === "mock" ? <span className="cu-badge cu-badge-mock">{UI.mock}</span> : null}
          {card.meta.route === "cached" ? (
            <span className="cu-badge">
              {card.meta.cachedRunAt
                ? savedRunLabel(routeLabelOf(card.meta), formatRunDate(card.meta.cachedRunAt))
                : routeLabelOf(card.meta)}
            </span>
          ) : null}
          {unformatted ? <span className="cu-badge cu-badge-warn">{UI.unformatted}</span> : null}
        </div>
        {interactive ? (
          <div className="cu-card-tools">
            <CopyButton text={plainTextOf(card)} label={UI.copyCard} compact />
            <button
              type="button"
              className="cu-icon-btn"
              onClick={() => ctl.closeCard()}
              aria-label={UI.close}
              title={UI.close}
              lang="en"
            >
              <XIcon aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </header>

      {card.heard === "none" ? (
        <div className="cu-no-speech">
          <p lang={tag}>{label(lang, "noSpeech")}</p>
          {interactive ? (
            <button type="button" className="cu-btn cu-btn-secondary" onClick={() => ui.checkSource()} lang="en">
              {UI.checkSource}
            </button>
          ) : null}
        </div>
      ) : unformatted ? (
        <div className="cu-unformatted">
          <p className="cu-unformatted-note" lang="en">
            {UI.unformattedNote}
          </p>
          <p className="cu-unformatted-text" lang={scriptLang(card.summary[0], hanAsJa)}>
            {card.summary[0]}
          </p>
          {latest ? (
            <button type="button" className="cu-btn cu-btn-secondary" onClick={() => ctl.retry()} lang="en">
              <ArrowClockwiseIcon aria-hidden="true" />
              <span>{UI.retry}</span>
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <AskBanner card={card} showQuote={card.ask.to === "you"} />
          <SayBlock card={card} compact={compact} />
          {card.heard === "partial" ? (
            <p className="cu-heard-note" lang={tag}>
              {label(lang, "partial")}
            </p>
          ) : null}
          {card.heard === "poor" ? (
            <p className="cu-heard-warn" lang={tag}>
              <WarningIcon aria-hidden="true" />
              <span>{label(lang, "poor")}</span>
            </p>
          ) : null}
          <div className="cu-summary">
            <p className="cu-summary-glance" lang={tag}>
              {card.summary[0]}
            </p>
            {card.summary[1] ? (
              <p className="cu-summary-context" lang={tag}>
                {card.summary[1]}
              </p>
            ) : null}
          </div>
          {card.facts.length > 0 ? (
            <ul className="cu-facts" aria-label={UI.factsLabel}>
              {card.facts.map((fact, i) => (
                <FactItem key={`${fact.kind}-${i}`} fact={fact} card={card} />
              ))}
            </ul>
          ) : null}
          <Evidence card={card} />
        </>
      )}

      <Receipt card={card} />
      {latest ? <RedoRow card={card} /> : null}
    </article>
  );
}
