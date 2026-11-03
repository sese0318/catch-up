// Sends one clip the way the press pipeline does and reads the event stream back.
// Shared by the in-process and the HTTP modes of the runner. Never logs audio or card text.
import {
  CARD_ENDPOINT,
  META_HEADER,
  WAV_CONTENT_TYPE,
  encodeMetaHeader,
  errorCodeFromStatus,
  errorData,
  isEventStream,
  readEventStream,
  type ErrorData,
  type PressMeta,
  type StageName,
  type WireCard,
} from "@/lib/protocol";

export interface CollectedPress {
  httpStatus: number;
  stages: { name: StageName; atMs: number }[];
  firstTokenMs: number | null;
  cardMs: number | null;
  totalMs: number;
  card: WireCard | null;
  error: ErrorData | null;
  failure: string | null;
  invalidEvents: number;
}

/** The POST /api/card request for one clip, with the raw WAV body and the meta header. */
export function buildCardRequest(origin: string, wav: Uint8Array, meta: PressMeta, signal?: AbortSignal): Request {
  return new Request(new URL(CARD_ENDPOINT, origin), {
    method: "POST",
    headers: { "Content-Type": WAV_CONTENT_TYPE, [META_HEADER]: encodeMetaHeader(meta) },
    body: wav.slice().buffer,
    signal,
  });
}

/**
 * Reads a /api/card response into timings and the card or error. Times are measured with now()
 * from t0, the moment the request started. A response that is not an event stream maps through
 * errorCodeFromStatus, like the client does.
 */
export async function collectPress(res: Response, now: () => number, t0: number): Promise<CollectedPress> {
  const out: CollectedPress = {
    httpStatus: res.status,
    stages: [],
    firstTokenMs: null,
    cardMs: null,
    totalMs: 0,
    card: null,
    error: null,
    failure: null,
    invalidEvents: 0,
  };
  if (!isEventStream(res) || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    out.error = errorData(errorCodeFromStatus(res.status));
    out.failure = "not_event_stream";
    out.totalMs = now() - t0;
    return out;
  }
  try {
    for await (const ev of readEventStream(res.body, () => (out.invalidEvents += 1))) {
      const at = now() - t0;
      if (ev.event === "stage") {
        out.stages.push({ name: ev.data.name, atMs: at });
        if (ev.data.name === "writing" && out.firstTokenMs === null) out.firstTokenMs = at;
      } else if (ev.event === "card") {
        if (out.card === null) {
          out.card = ev.data;
          out.cardMs = at;
        } else out.failure = "second_card";
      } else if (ev.event === "error") {
        out.error = ev.data;
      } else if (ev.event === "done") {
        break;
      }
    }
  } catch {
    out.failure = "stream_broke";
  }
  if (out.card && out.error) out.failure = "card_and_error";
  if (!out.card && !out.error && !out.failure) out.failure = "no_card";
  out.totalMs = now() - t0;
  return out;
}

/** Covers the entire HTTP press, including waiting for response headers, with one deadline. */
export async function collectPressWithTimeout(
  send: () => Promise<Response>,
  controller: AbortController,
  now: () => number,
  t0: number,
  timeoutMs: number,
): Promise<CollectedPress> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CollectedPress>((done) => {
    timer = setTimeout(() => {
      done({
        httpStatus: 0,
        stages: [],
        firstTokenMs: null,
        cardMs: null,
        totalMs: now() - t0,
        card: null,
        error: null,
        failure: "client_timeout",
        invalidEvents: 0,
      });
      controller.abort();
    }, Math.max(0, timeoutMs - (now() - t0)));
  });
  try {
    const work = send().then((res) => collectPress(res, now, t0));
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
