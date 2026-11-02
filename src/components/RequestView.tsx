// What fills the wait and what a failed press says (ux-spec 3 After a press, 7 Request).
// The stall line shows at 0 ms in the meeting language, then honest stages with an elapsed
// counter (hidden from screen readers), skeleton blocks in card order, and Still working at 6 s.
import { ERROR_ACTION_LABELS_EN, ERROR_COPY_EN, ERROR_INFO, STAGE_COPY_EN } from "@/lib/protocol";
import { UI, partialLabel, retryAfterLabel, sendingLabel, silentLabel } from "@/lib/client/copy";
import { useController, useNow, useSession, useSettings } from "@/lib/client/hooks";
import { label, tagOf } from "@/lib/client/local";
import { otherRoute, planRoute } from "@/lib/client/route";
import type { RequestView as RequestState } from "@/lib/client/session-state";
import { ArrowClockwiseIcon, CircleNotchIcon, InfoIcon, WarningIcon } from "./icons";
import { Notice } from "./ui";
import { useUi } from "./ui-context";

type Busy = Extract<RequestState, { phase: "busy" }>;

function stepText(request: Busy): string {
  switch (request.step) {
    case "capturing":
      return UI.gettingClip;
    case "sending":
      return request.partial && request.sentSec !== null ? partialLabel(request.sentSec) : sendingLabel(request.sentSec ?? 0);
    default:
      return STAGE_COPY_EN[request.step];
  }
}

function PressProgress({ request }: { request: Busy }) {
  const { settings } = useSettings();
  const now = useNow(true, true);
  const elapsed = now > 0 ? Math.max(0, Math.floor((now - request.pressedAt) / 1000)) : 0;
  const cardLang = settings.cardLang;
  const redo = request.kind === "further_back" || request.kind === "language";
  return (
    <div className="cu-progress" aria-busy="true">
      {!redo ? (
        <div className="cu-stall">
          <p className="cu-stall-label" lang={tagOf(cardLang)}>
            {label(cardLang, "stallLabel")}
          </p>
          <p className="cu-stall-line" lang={tagOf(request.stall.lang)}>
            {request.stall.text}
          </p>
        </div>
      ) : null}
      <p className="cu-stage" lang="en">
        <CircleNotchIcon aria-hidden="true" className="cu-spin" />
        <span>{stepText(request)}</span>
        {request.partial && request.step !== "sending" && request.sentSec !== null ? (
          <span className="cu-stage-sub">{partialLabel(request.sentSec)}</span>
        ) : null}
        <span className="cu-elapsed" aria-hidden="true">
          {elapsed} s
        </span>
      </p>
      {request.stillWorking ? (
        <p className="cu-still" lang="en">
          {UI.stillWorking}. {UI.stillWorkingDetail}
        </p>
      ) : null}
      {!redo ? (
        <div className="cu-skeleton" aria-hidden="true">
          <span className="cu-skel cu-skel-banner" />
          <span className="cu-skel cu-skel-say" />
          <span className="cu-skel cu-skel-line" />
          <span className="cu-skel cu-skel-line cu-skel-short" />
          <span className="cu-skel-chips">
            <span className="cu-skel cu-skel-chip" />
            <span className="cu-skel cu-skel-chip" />
            <span className="cu-skel cu-skel-chip" />
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ErrorView({ request }: { request: Extract<RequestState, { phase: "error" }> }) {
  const ctl = useController();
  const session = useSession();
  const { settings } = useSettings();
  const ui = useUi();
  const info = ERROR_INFO[request.code];
  const labels = ERROR_ACTION_LABELS_EN[info.action];
  const plan = planRoute(settings.route, session.health, session.mockParam);
  const other = otherRoute(request.route, plan, session.health);
  const copy = ERROR_COPY_EN[request.code];
  const sentLine = /\bsent\b/i.test(copy) ? null : request.sent ? UI.clipLeftOnce : UI.nothingLeft;

  const onAction = (index: number) => {
    switch (info.action) {
      case "retry":
        ctl.retry();
        break;
      case "retry_or_other_route":
        if (index === 0) ctl.retry();
        else if (other) ctl.retry(other);
        break;
      case "try_sample":
        ctl.dismissRequest();
        ui.revealSamples();
        break;
      case "check_source":
        ui.checkSource();
        break;
      case "reload":
        window.location.reload();
        break;
      case "none":
        break;
    }
  };

  return (
    <Notice
      tone="error"
      icon={<WarningIcon aria-hidden="true" />}
      actions={
        labels.length > 0 ? (
          <>
            {labels.map((text, index) =>
              info.action === "retry_or_other_route" && index === 1 && !other ? null : (
                <button
                  key={text}
                  type="button"
                  className={index === 0 ? "cu-btn cu-btn-secondary" : "cu-btn cu-btn-quiet"}
                  onClick={() => onAction(index)}
                >
                  {index === 0 && info.retryable ? <ArrowClockwiseIcon aria-hidden="true" /> : null}
                  <span>{text}</span>
                </button>
              ),
            )}
          </>
        ) : null
      }
    >
      <p>{copy}</p>
      {sentLine ? <p className="cu-notice-sub">{sentLine}</p> : null}
      {request.retryAfterSec ? <p className="cu-notice-sub">{retryAfterLabel(request.retryAfterSec)}</p> : null}
    </Notice>
  );
}

export function RequestView({ request }: { request: RequestState }) {
  const ctl = useController();
  const ui = useUi();
  switch (request.phase) {
    case "idle":
      return null;
    case "busy":
      return <PressProgress request={request} />;
    case "silent":
      return (
        <Notice
          tone="info"
          icon={<InfoIcon aria-hidden="true" />}
          actions={
            <>
              <button type="button" className="cu-btn cu-btn-secondary" onClick={() => ui.checkSource()}>
                {UI.checkSource}
              </button>
              <button type="button" className="cu-btn cu-btn-quiet" onClick={() => ctl.sendAnyway()}>
                {UI.sendAnyway}
              </button>
            </>
          }
        >
          <p>{silentLabel(request.windowSec)}</p>
        </Notice>
      );
    case "error":
      return <ErrorView request={request} />;
    case "cancelled":
      return (
        <Notice tone="info" icon={<InfoIcon aria-hidden="true" />}>
          <p>{ERROR_COPY_EN.aborted}</p>
        </Notice>
      );
  }
}
