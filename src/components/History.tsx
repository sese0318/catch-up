// This session (ux-spec 3 History). Memory only, newest first. A row shows the state chip,
// summary[0], the time and the window, and expands into the full card with Copy card.
// Export .md is a download on computers and the share sheet on phones. Clear asks once.
import { useId, useState } from "react";
import type { Card } from "@/lib/card/schema";
import { ASK_CHIPS, UI, cardWindow, clearCount } from "@/lib/client/copy";
import { exportCards } from "@/lib/client/export";
import { clockOfIso } from "@/lib/client/format";
import { useController, useSession } from "@/lib/client/hooks";
import { plainTextOf, tagOf } from "@/lib/client/local";
import { ownerWindowOf } from "@/lib/client/clipboard";
import { CardView } from "./CardView";
import { CaretDownIcon, DownloadSimpleIcon, TrashIcon } from "./icons";
import { CopyButton, cx } from "./ui";

function HistoryRow({ card, showing }: { card: Card; showing: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const chip = card.heard === "none" ? ASK_CHIPS.none : ASK_CHIPS[card.ask.to];
  const clock = clockOfIso(card.meta.pressedAt);
  const windowText = cardWindow(card.meta.windowSec, card.meta.sentSec);
  return (
    <li className="cu-history-row" data-ask={card.ask.to} data-showing={showing || undefined}>
      <button
        type="button"
        className="cu-history-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cu-history-top" lang="en">
          <span className={cx("cu-state-chip", `cu-state-${card.heard === "none" ? "none" : card.ask.to}`)}>{chip}</span>
          <span className="cu-history-when cu-tabular">
            {clock} · {windowText}
          </span>
          {showing ? <span className="cu-history-showing">{UI.latestCard}</span> : null}
          <CaretDownIcon aria-hidden="true" className="cu-disclosure-caret" />
        </span>
        <span className="cu-history-summary" lang={tagOf(card.meta.cardLang)}>
          {card.summary[0]}
        </span>
      </button>
      <div id={id} hidden={!open} className="cu-history-body">
        {open ? (
          <>
            <CardView card={card} interactive={false} compact headingLevel={3} />
            <CopyButton text={plainTextOf(card)} label={UI.copyCard} compact />
          </>
        ) : null}
      </div>
    </li>
  );
}

export function History({ preferShare = false, titleId = "cu-history-h" }: { preferShare?: boolean; titleId?: string }) {
  const session = useSession();
  const ctl = useController();
  const [confirming, setConfirming] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const cards = session.core.cards;

  const onExport = async (event: React.MouseEvent<HTMLButtonElement>) => {
    const result = await exportCards(cards, { preferShare, win: ownerWindowOf(event.currentTarget) });
    if (result === "downloaded" || result === "shared") {
      ctl.markExported();
      setExportNote(UI.exported);
    }
  };

  return (
    <section className="cu-history" aria-labelledby={titleId}>
      <div className="cu-history-head">
        <h2 id={titleId} className="cu-side-title" lang="en">
          {UI.thisSession}
          {cards.length > 0 ? <span className="cu-count"> ({cards.length})</span> : null}
        </h2>
        {cards.length > 0 ? (
          <div className="cu-history-actions" lang="en">
            <button type="button" className="cu-btn cu-btn-quiet cu-btn-small" onClick={onExport}>
              <DownloadSimpleIcon aria-hidden="true" />
              <span>{UI.exportMd}</span>
            </button>
            {!confirming ? (
              <button type="button" className="cu-btn cu-btn-quiet cu-btn-small" onClick={() => setConfirming(true)}>
                <TrashIcon aria-hidden="true" />
                <span>{UI.clear}</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="cu-btn cu-btn-danger cu-btn-small"
                  onClick={() => {
                    ctl.clearHistory();
                    setConfirming(false);
                    setExportNote(null);
                  }}
                >
                  {clearCount(cards.length)}
                </button>
                <button type="button" className="cu-btn cu-btn-quiet cu-btn-small" onClick={() => setConfirming(false)}>
                  {UI.keep}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
      <p className="cu-muted cu-history-note" lang="en">
        {UI.historyNote}
      </p>
      {exportNote && !session.core.unexported ? (
        <p className="cu-muted" role="status" lang="en">
          {exportNote}
        </p>
      ) : null}
      {cards.length === 0 ? (
        <p className="cu-history-empty" lang="en">
          {UI.noCatches}
        </p>
      ) : (
        <ol className="cu-history-list">
          {cards.map((card) => (
            <HistoryRow key={card.meta.id} card={card} showing={card.meta.id === session.core.currentId} />
          ))}
        </ol>
      )}
    </section>
  );
}
