// Press pipeline (ux-spec 3 and 9 item 2). Audio lane. Browser only.
// press(new) emits pressed with the stall line at 0 ms, freezes a snapshot, slices the window,
// runs the silence gate, POSTs the raw WAV to CARD_ENDPOINT with encodeMetaHeader, reads the
// stream with readEventStream, and emits stage, still_working (6 s), card (built with toCard) or
// error. One press at a time, 20 s hard cap, Esc cancels. The snapshot is held 2 minutes for
// further_back and language, then released. For a sample source, live failures fall back to the
// clip's saved card from getCachedCard.
import type { PressDeps, PressPipeline } from "../audio/types";

export function createPressPipeline(deps: PressDeps): PressPipeline {
  void deps;
  throw new Error("not implemented");
}

/** Random id for one page session, sent only as x-session-affinity. Matches the header pattern. */
export function newSessionId(): string {
  throw new Error("not implemented");
}
