// Press pipeline (ux-spec 3 and 9 item 2). Audio lane. Browser only.
// press(new) emits pressed with the stall line at 0 ms, freezes a snapshot, slices the window,
// runs the silence gate, builds PressMeta (names through normalizeNames, hint through
// normalizeHint), POSTs the raw WAV to CARD_ENDPOINT with encodeMetaHeader, reads the stream with
// readEventStream, and emits stage, still_working (6 s), card (built with toCard, meta.sent filled
// in) or error. One press at a time, 20 s hard cap. Esc or Cancel emits cancelled only, and
// aborted is kept for dispose() mid-press. An encode failure is error bad_request with sent false.
// The snapshot is held 2 minutes for further_back and language, then released. For a sample
// source, live failures fall back to the clip's saved card from getCachedCard, with a new id, this
// press's pressedAt and sent, and meta.cachedBecause set.
import type { PressDeps, PressPipeline } from "../audio/types";

export function createPressPipeline(deps: PressDeps): PressPipeline {
  void deps;
  throw new Error("not implemented");
}

/** Random id for one page session, sent only as x-session-affinity. Matches the header pattern. */
export function newSessionId(): string {
  throw new Error("not implemented");
}
