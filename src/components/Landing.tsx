// The empty card area. On a first visit it is the landing (ux-spec 5 Landing), with the sample
// strip and no permission prompts. While listening it says how to press, and while a sample plays
// it shows the muffle caption and when to press.
import type { SampleClip } from "@/lib/samples/catalog";
import { listSampleClips } from "@/lib/samples/catalog";
import { LANG_SHORT, UI, playingLabel } from "@/lib/client/copy";
import type { SampleView } from "@/lib/client/controller";
import { useController, useLevel, useSession, useSettings, useSettingsStore } from "@/lib/client/hooks";
import { tagOf } from "@/lib/client/local";
import { PlayIcon, SpeakerSlashIcon } from "./icons";
import { Notice } from "./ui";
import { SAMPLES_ID, useUi, type PanelSurface } from "./ui-context";

function safeClips(): readonly SampleClip[] {
  try {
    return listSampleClips();
  } catch {
    return [];
  }
}

function SpokenLangs({ clip }: { clip: SampleClip }) {
  const langs = clip.spokenLangs.filter((l): l is "en" | "ja" | "zh" => l !== "other");
  return (
    <>
      {langs.map((l) => (
        <span key={l}>
          <span aria-hidden="true"> · </span>
          <span lang={tagOf(l)}>{LANG_SHORT[l]}</span>
        </span>
      ))}
    </>
  );
}

export function SampleStrip({ compact = false }: { compact?: boolean }) {
  const ctl = useController();
  const clips = safeClips();
  return (
    <section className="cu-samples" id={SAMPLES_ID} aria-labelledby={`${SAMPLES_ID}-h`} tabIndex={-1}>
      <h3 id={`${SAMPLES_ID}-h`} className="cu-section-title" lang="en">
        {UI.trySample}
      </h3>
      {!compact ? (
        <p className="cu-muted" lang="en">
          {UI.sampleHelp}
        </p>
      ) : null}
      {clips.length === 0 ? (
        <p className="cu-muted" lang="en">
          {UI.noSamples}
        </p>
      ) : (
        <ul className="cu-sample-list">
          {clips.map((clip) => (
            <li key={clip.id}>
              <button type="button" className="cu-sample" onClick={() => ctl.playSample(clip)}>
                <PlayIcon aria-hidden="true" weight="fill" className="cu-sample-play" />
                <span className="cu-sample-text">
                  <span className="cu-sample-title" lang="en">
                    {clip.title}
                  </span>
                  <span className="cu-sample-meta">
                    <span lang="en">{Math.round(clip.durationSec)} s</span>
                    <SpokenLangs clip={clip} />
                  </span>
                  {!compact ? (
                    <span className="cu-sample-blurb" lang="en">
                      {clip.blurb}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SampleStatus({ sample, ended }: { sample: SampleView; ended: boolean }) {
  const playing = sample.phase === "playing" && !ended;
  return (
    <div className="cu-sample-status" lang="en">
      <p className="cu-section-title">{playingLabel(sample.title)}</p>
      <progress
        className="cu-sample-progress"
        max={Math.max(1, sample.durationSec)}
        value={Math.min(sample.currentSec, sample.durationSec)}
        aria-label={UI.sampleProgress}
      />
      {playing && sample.muffled ? (
        <p className="cu-muffled">
          <SpeakerSlashIcon aria-hidden="true" />
          <span>{UI.muffled}</span>
        </p>
      ) : null}
      {playing && !sample.muffled && !sample.keyMomentPassed ? <p className="cu-muted">{UI.sampleHelp}</p> : null}
      {sample.keyMomentPassed && playing ? <p className="cu-now-press">{UI.nowPress}</p> : null}
      {!playing ? <p className="cu-muted">{UI.sampleEnded}</p> : null}
    </div>
  );
}

function HowItWorks() {
  return (
    <ol className="cu-steps" lang="en">
      {UI.steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

function LandingNotices() {
  const session = useSession();
  const health = session.health;
  if (health.state !== "ok" || session.mockParam || health.data.mock) return null;
  if (!health.data.live) return <Notice tone="info">{UI.livePaused}</Notice>;
  if (!health.data.routes.open_weights.configured && !health.data.routes.meta_api.configured) {
    return <Notice tone="info">{UI.liveNotSetUp}</Notice>;
  }
  return null;
}

/** The card area when there is no card and no request. */
export function EmptyState({ surface }: { surface: PanelSurface }) {
  const session = useSession();
  const level = useLevel();
  const { hintsSeen } = useSettings();
  const store = useSettingsStore();
  const ui = useUi();
  const compact = surface === "pip" || surface === "app-compact";
  const capture = session.capture;
  const listening = capture.state === "listening";

  if (session.sample && (listening || capture.state === "starting")) {
    return <SampleStatus sample={session.sample} ended={listening && capture.endedAt !== undefined} />;
  }

  if (listening) {
    return (
      <div className="cu-empty" lang="en">
        <p className="cu-empty-title">{UI.emptyListening}</p>
        {!level.soundOk ? <p className="cu-muted">{UI.levelCheck}</p> : null}
        {session.support.phone && !hintsSeen.phone ? (
          <Notice
            tone="info"
            actions={
              <button type="button" className="cu-btn cu-btn-quiet" onClick={() => store.markHintSeen("phone")}>
                {UI.gotIt}
              </button>
            }
          >
            {UI.phoneKeepOn}
          </Notice>
        ) : null}
        {ui.samplesRevealed ? <SampleStrip compact={compact} /> : null}
      </div>
    );
  }

  return (
    <div className="cu-landing">
      <LandingNotices />
      {!compact ? (
        <div className="cu-landing-intro" lang="en">
          <p className="cu-landing-tagline">{UI.tagline}</p>
          <p className="cu-muted">{UI.promise}</p>
        </div>
      ) : null}
      <SampleStrip compact={compact} />
      {surface === "phone" ? (
        <p className="cu-muted" lang="en">
          {UI.phoneOnlyRoom}
        </p>
      ) : null}
      {!compact ? (
        <div className="cu-landing-real">
          <h3 className="cu-section-title" lang="en">
            {UI.howItWorks}
          </h3>
          <HowItWorks />
          <button type="button" className="cu-btn cu-btn-secondary cu-btn-wide" onClick={() => ui.useReal()} lang="en">
            {UI.useReal}
          </button>
        </div>
      ) : null}
      {surface === "phone" ? (
        <p className="cu-landing-foot" lang="en">
          <span className="cu-built-with">{UI.builtWith}</span>.{" "}
          <button type="button" className="cu-link-btn" onClick={() => ui.openSheet("privacy")}>
            {UI.howAudioHandled}
          </button>
        </p>
      ) : null}
    </div>
  );
}
