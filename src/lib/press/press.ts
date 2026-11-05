// Press pipeline (ux-spec 3 and 9 item 2). Audio lane. Browser only.
// press(new) emits pressed with the stall line at 0 ms, freezes a snapshot, slices the window,
// runs the silence gate, builds PressMeta (names through normalizeNames, hint through
// normalizeHint), POSTs the raw WAV to CARD_ENDPOINT with encodeMetaHeader, reads the stream with
// readEventStream, and emits stage, still_working (6 s), card (built with toCard, meta.sent filled
// in) or error. One press at a time, 30 s hard cap. Esc or Cancel emits cancelled only, and
// aborted is kept for dispose() mid-press. An encode failure is error bad_request with sent false.
// The snapshot is held 2 minutes for further_back and language, then released. For a sample
// source, live failures fall back to the clip's saved card from getCachedCard, with a new id, this
// press's pressedAt and sent, and meta.cachedBecause set.
import type { Card, CardLang, CardRoute, CardTimings, SentRecord, Source, WindowSec } from "../card/schema";
import { stallLine } from "../card/strings";
import {
  CARD_ENDPOINT,
  ERROR_INFO,
  LIMITS,
  META_HEADER,
  PROTOCOL_VERSION,
  TRANSCRIPT_CONTENT_TYPE,
  WAV_CONTENT_TYPE,
  encodeMetaHeader,
  errorCodeFromStatus,
  isEventStream,
  normalizeHint,
  normalizeNames,
  readEventStream,
  toCard,
  toLocalIso,
  type ErrorCode,
  type ErrorData,
  type PressMeta,
  type RoutePreference,
  type WireCard,
} from "../protocol";
import { getCachedCard, getSampleClip, type SampleClip } from "../samples/catalog";
import { isPartial } from "../audio/clip";
import { randomId } from "../audio/ids";
import {
  isWarmingUp,
  nextWindow,
  type ClipSlice,
  type LiveStatus,
  type PressDeps,
  type PressEvent,
  type PressKind,
  type PressPipeline,
  type PressRefusal,
  type PressRequest,
  type PressResult,
  type PressSettings,
  type Snapshot,
} from "../audio/types";

/** Shown only if the card lane's stallLine is missing or fails. The ux-spec 2-7 English line. */
const FALLBACK_STALL = "Let me think about that for a second.";
const NOTHING_SENT: SentRecord = { body: "none", names: false, hint: false };
/** A press time further from now than this is not trusted for the timers. */
const MAX_PRESS_SKEW_MS = 2_000;
/** How long the stream may run on after the card or an error before it is cut. */
const DRAIN_MS = 2_000;

type Timer = ReturnType<typeof setTimeout>;
type BodyKind = "audio" | "transcript";
type PressErrorEvent = Extract<PressEvent, { type: "error" }>;

interface Plan {
  kind: PressKind;
  windowSec: WindowSec;
  cardLang: CardLang;
  route: RoutePreference;
  body: BodyKind;
  replaces: string | null;
  bypassGate: boolean; // send_anyway
}

/** The press snapshot and what the latest attempt on it produced. */
interface Held {
  snapshot: Snapshot;
  until: number;
  pressedAt: number; // the press moment every redo keeps
  source: Source;
  clipId: string | null; // sample clip, for the cached stand-in
  windowSec: WindowSec;
  cardLang: CardLang;
  sentSec: number;
  cardId: string | null;
  route: CardRoute | null;
  transcript: string | null; // Route A only, for a language redo
  silent: ClipSlice | null; // what the silence gate held back, for send_anyway
  bypassed: boolean; // Send anyway already overrode the gate for this press, so redos skip it too
  failed: Plan | null; // for retry
  timer: Timer | null;
}

interface Attempt {
  pressId: string;
  plan: Plan;
  settings: PressSettings;
  pressedAt: number;
  startedAt: number;
  clipId: string | null;
  held: Held | null;
  controller: AbortController;
  timers: Timer[];
  finished: boolean;
  sent: boolean;
  sentRecord: SentRecord;
  body: ArrayBuffer | null; // zeroed when the attempt ends
}

interface Planned {
  plan: Plan;
  pressedAt: number;
  fresh: boolean; // takes a new snapshot
  clipId: string | null;
  held: Held | null;
}

const noop = () => undefined;

function refuse(reason: PressRefusal): PressResult {
  return { accepted: false, reason };
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function utf8(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function zero(buffer: ArrayBuffer | null | undefined): void {
  if (buffer && buffer.byteLength > 0) new Uint8Array(buffer).fill(0);
}

function stallFor(lang: CardLang): { text: string; lang: CardLang } {
  try {
    const text = stallLine(lang);
    if (typeof text === "string" && text.trim()) return { text, lang };
  } catch {
    // the card lane's strings are not there yet
  }
  return { text: FALLBACK_STALL, lang: "en" };
}

/**
 * The code the server would refuse this route with before reading the body, from /api/health, or
 * null. Never daily_cap, which lives in each server instance. Mock is never refused here.
 */
function localRefusal(route: RoutePreference, live: LiveStatus | undefined): "live_off" | "not_configured" | null {
  if (!live || route === "mock") return null;
  const target = route === "auto" ? live.defaultRoute : route;
  if (target === "mock") return null;
  if (live.liveOff) return "live_off";
  if (target === "auto") return live.configured.length > 0 ? null : "not_configured";
  return live.configured.includes(target) ? null : "not_configured";
}

function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sample clip asks a fictional listener by name, so its press sends the clip's names and meeting
 * language. The visitor's own names would turn that ask into a question to the room, and the
 * visitor's session hint is about their own conversation, so it never goes with a sample.
 */
function sampleSettings(settings: PressSettings, clipId: string | null): PressSettings {
  if (!clipId) return settings;
  let clip: SampleClip | null = null;
  try {
    clip = getSampleClip(clipId);
  } catch {
    clip = null;
  }
  if (!clip) return settings;
  return {
    ...settings,
    names: clip.listenerNames ?? settings.names,
    meetingLang: clip.meetingLang ?? settings.meetingLang,
    hint: "",
  };
}

function copyCard(card: Card): Card {
  return typeof structuredClone === "function" ? structuredClone(card) : (JSON.parse(JSON.stringify(card)) as Card);
}

class Pipeline implements PressPipeline {
  private readonly listeners = new Set<(event: PressEvent) => void>();
  private current: Attempt | null = null;
  private held: Held | null = null;
  private disposed = false;
  private freshSeq = 0; // bumps when a press asks for a new snapshot, so a cancelled press's late one is dropped
  private readonly unsubscribeEngine: () => void;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly now: () => number;

  constructor(private readonly deps: PressDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.endpoint = deps.endpoint ?? CARD_ENDPOINT;
    this.now = deps.now ?? (() => Date.now());
    this.unsubscribeEngine = deps.engine.subscribe(() => this.onEngineChange());
  }

  press(request: PressRequest): PressResult {
    try {
      if (this.disposed) return refuse("not_listening");
      if (this.current) return refuse("busy");
      const settings = this.deps.getSettings();
      const planned = this.plan(request, settings);
      if ("reason" in planned) return refuse(planned.reason);
      return this.begin(planned, sampleSettings(settings, planned.clipId));
    } catch {
      return refuse("not_listening");
    }
  }

  cancel(): void {
    const a = this.current;
    if (!a) return;
    const held = this.heldOf(a);
    if (held) held.failed = a.plan;
    this.finish(a);
    this.emit({ type: "cancelled", pressId: a.pressId, sent: a.sent });
  }

  isBusy(): boolean {
    return this.current !== null;
  }

  heldUntil(): number | null {
    const held = this.held;
    return held && !held.snapshot.released ? held.until : null;
  }

  on(listener: (event: PressEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    const a = this.current;
    if (a) this.fail(a, "aborted");
    this.dropHeld();
    this.disposed = true;
    this.unsubscribeEngine();
    this.listeners.clear();
  }

  // Planning

  private plan(request: PressRequest, settings: PressSettings): Planned | { reason: PressRefusal } {
    if (request.kind === "new") {
      const engine = this.deps.engine;
      if (engine.getStatus().state !== "listening") return { reason: "not_listening" };
      if (isWarmingUp(engine.memorySeconds())) return { reason: "warming_up" };
      const spec = engine.getSource();
      return {
        plan: {
          kind: "new",
          windowSec: settings.windowSec,
          cardLang: settings.cardLang,
          route: settings.route,
          body: "audio",
          replaces: null,
          bypassGate: false,
        },
        pressedAt: request.pressedAt,
        fresh: true,
        clipId: spec?.kind === "sample" ? spec.clipId : null,
        held: null,
      };
    }

    const held = this.liveHeld();
    if (!held) return { reason: "nothing_held" };
    const base = { pressedAt: held.pressedAt, fresh: false, clipId: held.clipId, held };
    switch (request.kind) {
      case "further_back": {
        const next = nextWindow(held.windowSec);
        // The card already holds all there was. A partial card, or memory barely past what was sent,
        // would only send the same clip again as a new live call.
        const partial = isPartial({ sentSec: held.sentSec, windowSec: held.windowSec });
        if (!next || partial || held.snapshot.memorySec <= held.sentSec + 0.5) return { reason: "nothing_more" };
        const plan: Plan = {
          kind: "further_back",
          windowSec: next,
          cardLang: held.cardLang,
          route: settings.route,
          body: "audio",
          replaces: held.cardId,
          bypassGate: held.bypassed,
        };
        return { ...base, plan };
      }
      case "language": {
        // Route A reuses its transcript, so the redo skips transcription.
        const transcript =
          held.route === "meta_api" && !!held.transcript && utf8Length(held.transcript) <= LIMITS.maxTranscriptBytes;
        const plan: Plan = {
          kind: "language",
          windowSec: held.windowSec,
          cardLang: request.cardLang,
          route: transcript ? "meta_api" : settings.route,
          body: transcript ? "transcript" : "audio",
          replaces: held.cardId,
          bypassGate: held.bypassed,
        };
        return { ...base, plan };
      }
      case "send_anyway": {
        if (!held.silent) return { reason: "nothing_held" };
        const plan: Plan = {
          kind: "send_anyway",
          windowSec: held.silent.windowSec,
          cardLang: held.cardLang,
          route: settings.route,
          body: "audio",
          replaces: held.cardId,
          bypassGate: true,
        };
        return { ...base, plan };
      }
      case "retry": {
        const failed = held.failed;
        if (!failed) return { reason: "nothing_held" };
        const route = request.route ?? failed.route;
        const transcript = failed.body === "transcript" && route === "meta_api" && !!held.transcript;
        const plan: Plan = {
          kind: "retry",
          windowSec: failed.windowSec,
          cardLang: failed.cardLang,
          route,
          body: transcript ? "transcript" : "audio",
          replaces: held.cardId,
          bypassGate: failed.bypassGate,
        };
        return { ...base, plan };
      }
    }
  }

  private begin(p: Planned, settings: PressSettings): PressResult {
    const now = this.now();
    const pressId = `press_${randomId(9)}`;
    const trusted = p.plan.kind === "new" && p.pressedAt <= now && now - p.pressedAt < MAX_PRESS_SKEW_MS;
    const startedAt = trusted ? p.pressedAt : now;
    const a: Attempt = {
      pressId,
      plan: p.plan,
      settings,
      pressedAt: p.pressedAt,
      startedAt,
      clipId: p.clipId,
      held: p.held,
      controller: new AbortController(),
      timers: [],
      finished: false,
      sent: false,
      sentRecord: NOTHING_SENT,
      body: null,
    };
    this.current = a;
    this.emit({
      type: "pressed",
      pressId,
      kind: p.plan.kind,
      pressedAt: p.pressedAt,
      startedAt,
      stall: stallFor(settings.meetingLang),
    });
    if (!a.finished) {
      a.timers.push(setTimeout(() => this.stillWorking(a), Math.max(0, startedAt + LIMITS.stillWorkingMs - now)));
      a.timers.push(setTimeout(() => this.hardCap(a), Math.max(0, startedAt + LIMITS.hardCapMs - now)));
    }
    void this.run(a, p.fresh).catch(() => this.fail(a, "bad_request"));
    return { accepted: true, pressId };
  }

  // One attempt

  private async run(a: Attempt, fresh: boolean): Promise<void> {
    if (a.finished) return;
    let held: Held;
    if (fresh) {
      this.dropHeld();
      const ticket = ++this.freshSeq;
      let snapshot: Snapshot;
      try {
        snapshot = await this.deps.engine.snapshot();
      } catch {
        return this.fail(a, this.captureStopped() ? "aborted" : "bad_audio");
      }
      if (this.disposed || ticket !== this.freshSeq) {
        // Disposed, or this press was cancelled and a newer one already asked for its own snapshot.
        snapshot.release();
        return;
      }
      held = this.hold(snapshot, a); // held even after a cancel, so Retry can reuse it
      a.held = held;
      if (a.finished) {
        held.failed = a.plan;
        return;
      }
    } else {
      if (!a.held || a.held !== this.held || a.held.snapshot.released) return this.fail(a, "aborted");
      held = a.held;
    }

    // Body
    const windowSec = a.plan.windowSec;
    let body: ArrayBuffer;
    let contentType: string;
    let sentSec: number;
    let route = a.plan.route;
    if (a.plan.body === "transcript" && held.transcript) {
      body = utf8(held.transcript);
      contentType = TRANSCRIPT_CONTENT_TYPE;
      sentSec = held.sentSec;
      route = "meta_api";
    } else {
      let slice: ClipSlice;
      if (a.plan.kind === "send_anyway" && held.silent) slice = held.silent;
      else {
        try {
          slice = await held.snapshot.slice(windowSec);
        } catch {
          return this.fail(a, held.snapshot.released ? "aborted" : "bad_audio"); // a pause zeroed it mid-press
        }
        if (a.finished) {
          zero(slice.wav);
          return;
        }
      }
      if (slice.silent && !a.plan.bypassGate) {
        if (this.held === held) {
          if (held.silent !== slice) zero(held.silent?.wav);
          held.silent = slice;
          held.windowSec = slice.windowSec;
          held.cardLang = a.plan.cardLang;
          held.sentSec = slice.sentSec;
        } else zero(slice.wav);
        this.finish(a);
        this.emit({ type: "silent", pressId: a.pressId, windowSec: slice.windowSec, sentSec: slice.sentSec });
        return;
      }
      if (held.silent === slice) held.silent = null;
      body = slice.wav;
      contentType = WAV_CONTENT_TYPE;
      sentSec = slice.sentSec;
      if (sentSec < LIMITS.minClipSec) {
        zero(body);
        return this.fail(a, "bad_audio");
      }
    }
    a.body = body;

    // Header. Names and the hint are normalized first, because encodeMetaHeader throws on raw input.
    const settings = a.settings;
    const names = normalizeNames(settings.names);
    const hint = normalizeHint(settings.hint);
    const meta: PressMeta = {
      v: PROTOCOL_VERSION,
      pressedAt: toLocalIso(a.pressedAt),
      cardLang: a.plan.cardLang,
      meetingLang: settings.meetingLang,
      windowSec,
      sentSec,
      source: held.source,
      names,
      route,
      sessionId: this.deps.sessionId,
    };
    const tz = settings.tz ?? localTimeZone();
    if (tz && tz.length <= 64) meta.tz = tz;
    if (hint !== undefined) meta.hint = hint;
    if (route === "mock" && settings.mock) meta.mock = settings.mock;
    let header: string;
    try {
      header = encodeMetaHeader(meta);
    } catch {
      return this.fail(a, "bad_request");
    }

    // The server would refuse this unread, so the clip never leaves the device.
    const refusal = localRefusal(route, settings.live);
    if (refusal) return this.fail(a, refusal);
    if (isOffline()) return this.fail(a, "offline");

    const bytes = body.byteLength;
    this.emit({ type: "sending", pressId: a.pressId, windowSec, sentSec, bytes, partial: sentSec < windowSec - 0.05 });
    a.sentRecord = { body: contentType === WAV_CONTENT_TYPE ? "audio" : "transcript", names: names.length > 0, hint: hint !== undefined };
    a.sent = true;
    const requestAt = this.now();
    const fetchImpl = this.fetchImpl;
    let res: Response;
    try {
      res = await fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": contentType, [META_HEADER]: header },
        body, // raw bytes, never a Blob, never base64
        signal: a.controller.signal,
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch {
      if (a.finished) return;
      if (isOffline()) {
        a.sent = false;
        a.sentRecord = NOTHING_SENT;
        return this.fail(a, "offline");
      }
      return this.fail(a, "network");
    }
    if (a.finished) {
      void res.body?.cancel().catch(noop);
      return;
    }
    if (!isEventStream(res) || !res.body) {
      void res.body?.cancel().catch(noop);
      return this.fail(a, res.ok ? "server_error" : errorCodeFromStatus(res.status));
    }

    let receivedAt: number | undefined;
    let writingAt: number | undefined;
    // After the card or an error the stream is read to done without aborting, so the server sees
    // a clean finish. DRAIN_MS bounds that wait.
    let draining = false;
    let drainTimer: Timer | null = null;
    const drain = () => {
      draining = true;
      drainTimer = setTimeout(() => a.controller.abort(), DRAIN_MS);
    };
    try {
      for await (const ev of readEventStream(res.body)) {
        if (draining) {
          if (ev.event === "done") break;
          continue;
        }
        if (a.finished) return;
        if (ev.event === "stage") {
          const at = this.now();
          if (ev.data.name === "received" && receivedAt === undefined) receivedAt = at;
          if (ev.data.name === "writing" && writingAt === undefined) writingAt = at;
          this.emit({ type: "stage", pressId: a.pressId, name: ev.data.name, elapsedMs: Math.max(0, at - a.startedAt) });
        } else if (ev.event === "card") {
          this.deliver(a, held, ev.data, { requestAt, receivedAt, writingAt }, sentSec, bytes);
          drain();
        } else if (ev.event === "error") {
          this.fail(a, ev.data.code, ev.data, false);
          drain();
        } else if (ev.event === "done") {
          break;
        }
      }
    } catch {
      if (draining || a.finished) return;
      return this.fail(a, "network");
    } finally {
      if (drainTimer !== null) clearTimeout(drainTimer);
    }
    if (!a.finished) this.fail(a, "server_error"); // the stream ended without a card or an error
  }

  private deliver(
    a: Attempt,
    held: Held,
    wire: WireCard,
    times: { requestAt: number; receivedAt?: number; writingAt?: number },
    sentSec: number,
    bytes: number,
  ): void {
    if (a.finished) return;
    const ms: CardTimings = { total: Math.max(0, this.now() - a.startedAt) };
    if (times.writingAt !== undefined) ms.firstToken = Math.max(0, times.writingAt - a.startedAt);
    if (times.receivedAt !== undefined) ms.upload = Math.max(0, times.receivedAt - times.requestAt);
    const card = toCard(wire, {
      id: `card_${randomId(12)}`,
      pressedAt: toLocalIso(a.pressedAt),
      windowSec: a.plan.windowSec,
      sentSec,
      cardLang: a.plan.cardLang,
      source: held.source,
      ms,
      bytesSent: bytes,
      sent: a.sentRecord,
    });
    this.finish(a, false);
    if (this.held === held) {
      if (a.plan.bypassGate) held.bypassed = true;
      held.cardId = card.meta.id;
      held.route = card.meta.route;
      held.windowSec = a.plan.windowSec;
      held.cardLang = a.plan.cardLang;
      if (a.plan.body === "audio") held.sentSec = sentSec;
      held.transcript = card.meta.transcript ?? (a.plan.body === "transcript" ? held.transcript : null);
      held.failed = card.meta.unformatted ? a.plan : null; // Retry on an Unformatted card runs the plan again
    }
    this.emit({ type: "card", pressId: a.pressId, card, replaces: a.plan.replaces, server: wire.meta.timing });
  }

  private fail(a: Attempt, code: ErrorCode, data?: Partial<ErrorData>, abort = true): void {
    if (a.finished) return;
    const held = this.heldOf(a);
    if (code !== "aborted") {
      const cached = this.cachedStandIn(a, code);
      if (cached) {
        this.finish(a, abort);
        if (held) {
          held.cardId = cached.meta.id;
          held.route = cached.meta.route;
          held.windowSec = a.plan.windowSec;
          held.cardLang = a.plan.cardLang;
          held.transcript = null;
          held.failed = null;
        }
        this.emit({ type: "card", pressId: a.pressId, card: cached, replaces: a.plan.replaces, server: null });
        return;
      }
    }
    if (held) held.failed = a.plan;
    this.finish(a, abort);
    const event: PressErrorEvent = {
      type: "error",
      pressId: a.pressId,
      code,
      retryable: data?.retryable ?? ERROR_INFO[code].retryable,
      sent: a.sent,
    };
    if (data?.route) event.route = data.route;
    if (data?.cause) event.cause = data.cause;
    if (data?.retryAfterSec !== undefined) event.retryAfterSec = data.retryAfterSec;
    this.emit(event);
  }

  /** A sample's saved real card, standing in when the live call failed, was capped or is off. */
  private cachedStandIn(a: Attempt, code: ErrorCode): Card | null {
    if (!a.clipId || a.plan.route === "mock") return null;
    let saved: Card | null = null;
    try {
      saved = getCachedCard(a.clipId, a.plan.cardLang);
    } catch {
      saved = null;
    }
    if (!saved || saved.meta.route !== "cached" || !saved.meta.cachedFrom || !saved.meta.cachedRunAt) return null;
    const card = copyCard(saved);
    card.meta = {
      ...card.meta,
      id: `card_${randomId(12)}`,
      pressedAt: toLocalIso(a.pressedAt),
      sent: a.sent ? { ...a.sentRecord } : { ...NOTHING_SENT },
      cachedBecause: code,
    };
    return card;
  }

  private stillWorking(a: Attempt): void {
    if (a.finished || this.current !== a) return;
    this.emit({ type: "still_working", pressId: a.pressId, elapsedMs: Math.max(0, this.now() - a.startedAt) });
  }

  private hardCap(a: Attempt): void {
    if (!a.finished) this.fail(a, "timeout");
  }

  /** Ends the attempt. abort false leaves a stream that already answered to finish on its own. */
  private finish(a: Attempt, abort = true): void {
    if (a.finished) return;
    a.finished = true;
    for (const t of a.timers) clearTimeout(t);
    a.timers = [];
    if (this.current === a) this.current = null;
    if (abort) {
      try {
        a.controller.abort();
      } catch {
        // nothing to abort
      }
    }
    zero(a.body); // fetch copied the bytes when the request was made
    a.body = null;
  }

  // Held snapshot

  private hold(snapshot: Snapshot, a: Attempt): Held {
    const until = snapshot.takenAt + LIMITS.snapshotHoldMs;
    const held: Held = {
      snapshot,
      until,
      pressedAt: a.pressedAt,
      source: snapshot.source,
      clipId: a.clipId,
      windowSec: a.plan.windowSec,
      cardLang: a.plan.cardLang,
      sentSec: 0,
      cardId: null,
      route: null,
      transcript: null,
      silent: null,
      bypassed: false,
      failed: null,
      timer: null,
    };
    const left = Math.max(0, LIMITS.snapshotHoldMs - Math.max(0, Date.now() - snapshot.takenAt));
    held.timer = setTimeout(() => {
      if (this.held === held) this.dropHeld();
    }, left);
    this.held = held;
    this.emit({ type: "held", until, memorySec: snapshot.memorySec });
    return held;
  }

  private heldOf(a: Attempt): Held | null {
    return a.held && a.held === this.held ? a.held : null;
  }

  private liveHeld(): Held | null {
    const held = this.held;
    if (!held) return null;
    if (held.snapshot.released) {
      this.dropHeld();
      return null;
    }
    return held;
  }

  /** Zeroes the held snapshot, the held-back slice and the transcript. */
  private dropHeld(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    if (held.timer !== null) clearTimeout(held.timer);
    held.timer = null;
    held.snapshot.release();
    if (held.silent) zero(held.silent.wav);
    held.silent = null;
    held.transcript = null;
    this.emit({ type: "held", until: null });
  }

  /** Pause, a lost source or a phone hiding the page ended capture while a press was starting. */
  private captureStopped(): boolean {
    return this.deps.engine.getStatus().state !== "listening";
  }

  private onEngineChange(): void {
    if (this.held?.snapshot.released) this.dropHeld(); // a pause zeroed it
  }

  private emit(event: PressEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // one failing listener never stops the press
      }
    }
  }
}

export function createPressPipeline(deps: PressDeps): PressPipeline {
  return new Pipeline(deps);
}

/** Random id for one page session, sent only as x-session-affinity. Matches the header pattern. */
export function newSessionId(): string {
  return randomId(16);
}
