import { describe, expect, it } from "vitest";
import { Card, type CardBody } from "./card/schema";
import { copyRuleProblems } from "./copy-rules";
import {
  ERROR_ACTION_LABELS_EN,
  ERROR_CODES,
  ERROR_COPY_EN,
  ERROR_INFO,
  HealthResponse,
  LIMITS,
  PROVIDER_FAILURES,
  STAGE_COPY_EN,
  bodyKindOf,
  checkClipWav,
  createEventStreamParser,
  decodeMetaHeader,
  encodeEvent,
  encodeEventBytes,
  encodeMetaHeader,
  errorCodeFromFailure,
  errorCodeFromStatus,
  errorData,
  errorEventResponse,
  inspectWav,
  isEventStream,
  readEventStream,
  toCard,
  toLocalIso,
  weekdayOfIso,
  type PressMeta,
  type StreamEvent,
  type WireCard,
} from "./protocol";

const meta: PressMeta = {
  v: 1,
  pressedAt: "2026-11-02T10:42:40.123-05:00",
  tz: "America/New_York",
  cardLang: "ja",
  meetingLang: "en",
  windowSec: 30,
  sentSec: 30,
  source: "tab",
  names: ["Seika", "セイカ", "星佳"],
  hint: "Prof. Gagne, PSY-201, operant conditioning",
  route: "auto",
  sessionId: "0f6c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
};

const body: CardBody = {
  heard: "clear",
  ask: { to: "you", text: "デモは木曜でいいか、月曜に延ばすか", by: "Alex" },
  say: {
    text: "Just to check, Thursday for the demo, or push to Monday?",
    lang: "en",
    gloss: "確認です。デモは木曜ですか、月曜に延ばしますか。",
  },
  summary: ["デモの日程を聞かれた", "木曜か月曜かを決める流れ"],
  facts: [
    { kind: "date", text: "11月5日(木)", note: "Thursday" },
    { kind: "number", text: "15%", note: "50%かも", unsure: true },
  ],
  quote: "So Seika, does Thursday work for the demo, or should we push to Monday?",
};

const wire: WireCard = {
  ...body,
  meta: {
    route: "open_weights",
    model: "meta-models/muse-spark-open-1026",
    parse: "clean",
    timing: { totalMs: 3100, firstTokenMs: 2200, bytes: 960_044 },
    usage: { inputTokens: 1100, audioTokens: 375, outputTokens: 600 },
  },
};

function makeWav(o: {
  seconds?: number;
  sampleRate?: number;
  channels?: number;
  bits?: number;
  formatTag?: number;
  listChunk?: boolean;
} = {}): Uint8Array {
  const { seconds = 2, sampleRate = 16_000, channels = 1, bits = 16, formatTag = 1, listChunk = false } = o;
  const dataBytes = Math.round(seconds * sampleRate) * channels * (bits / 8);
  const listBytes = listChunk ? 8 + 5 + 1 : 0; // odd-sized chunk plus its pad byte
  const out = new Uint8Array(44 + listBytes + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (offset: number, s: string) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, out.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, formatTag, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * (bits / 8), true);
  v.setUint16(32, channels * (bits / 8), true);
  v.setUint16(34, bits, true);
  let pos = 36;
  if (listChunk) {
    tag(pos, "LIST");
    v.setUint32(pos + 4, 5, true);
    pos += listBytes;
  }
  tag(pos, "data");
  v.setUint32(pos + 4, dataBytes, true);
  return out;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of readEventStream(stream)) out.push(ev);
  return out;
}

const allEvents: StreamEvent[] = [
  { event: "stage", data: { name: "received", ms: 12 } },
  { event: "stage", data: { name: "writing", ms: 2210 } },
  { event: "card", data: wire },
  { event: "done", data: {} },
];

describe("X-CatchUp-Meta header", () => {
  it("round-trips Unicode names as base64url", () => {
    const header = encodeMetaHeader(meta);
    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodeMetaHeader(header);
    expect(decoded).toEqual({ ok: true, meta });
  });

  it("reports problems by field name, never by value", () => {
    expect(decodeMetaHeader(null)).toEqual({ ok: false, issue: "missing" });
    expect(decodeMetaHeader("a".repeat(LIMITS.maxMetaHeaderChars + 1))).toEqual({ ok: false, issue: "too_long" });
    expect(decodeMetaHeader("not base64!")).toEqual({ ok: false, issue: "not_base64url" });
    expect(decodeMetaHeader(btoa("{nope").replace(/=+$/, ""))).toEqual({ ok: false, issue: "not_json" });
    const bad = btoa(JSON.stringify({ ...meta, windowSec: 45, names: ["x"] })).replace(/=+$/, "");
    const result = decodeMetaHeader(bad.replace(/\+/g, "-").replace(/\//g, "_"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue).toBe("invalid windowSec");
      expect(result.issue).not.toContain("45");
    }
  });

  it("enforces width caps, the offset in pressedAt and mock only with route mock", () => {
    const tooWide = { ...meta, names: ["星佳星佳星佳星佳星佳星佳星佳星佳星佳星佳", "セイカセイカセイカセイカセイカ"] };
    expect(() => encodeMetaHeader(tooWide)).toThrow();
    expect(() => encodeMetaHeader({ ...meta, hint: "あ".repeat(61) })).toThrow();
    expect(() => encodeMetaHeader({ ...meta, hint: "あ".repeat(60) })).not.toThrow();
    expect(() => encodeMetaHeader({ ...meta, pressedAt: "2026-11-02T10:42:40" })).toThrow();
    expect(() => encodeMetaHeader({ ...meta, mock: { mode: "ok" } })).toThrow();
    expect(() => encodeMetaHeader({ ...meta, route: "mock", mock: { mode: "slow", fixture: "room" } })).not.toThrow();
    expect(() => encodeMetaHeader({ ...meta, names: ["a", "b", "c", "d"] })).toThrow();
    expect(() => encodeMetaHeader({ ...meta, sessionId: "short" })).toThrow();
  });

  it("tells WAV bodies from transcript bodies", () => {
    expect(bodyKindOf("audio/wav")).toBe("wav");
    expect(bodyKindOf("audio/x-wav")).toBe("wav");
    expect(bodyKindOf("text/plain; charset=utf-8")).toBe("transcript");
    expect(bodyKindOf("application/json")).toBeNull();
    expect(bodyKindOf(null)).toBeNull();
  });
});

describe("event stream", () => {
  it("encodes one single-line JSON data field per event", () => {
    const text = encodeEvent(allEvents[2]);
    expect(text.startsWith("event: card\ndata: {")).toBe(true);
    expect(text.endsWith("}\n\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(4);
  });

  it("parses every event back unchanged", async () => {
    const bytes = allEvents.map(encodeEventBytes);
    expect(await collect(streamOf(bytes))).toEqual(allEvents);
  });

  it("survives a split at every byte, including inside multibyte characters", async () => {
    const whole = new Uint8Array(allEvents.flatMap((e) => [...encodeEventBytes(e)]));
    for (let cut = 1; cut < whole.length; cut += 7) {
      const events = await collect(streamOf([whole.slice(0, cut), whole.slice(cut)]));
      expect(events).toEqual(allEvents);
    }
  });

  it("accepts CRLF and CR line endings and ignores comments and unknown events", () => {
    const seen: StreamEvent[] = [];
    const parser = createEventStreamParser((e) => seen.push(e));
    const crlf = ": keep-alive\r\nevent: ping\r\ndata: {}\r\n\r\nevent: stage\r\ndata: {\"name\":\"received\"}\r";
    for (const ch of crlf) parser.push(ch);
    parser.push("\n\r\nevent: done\rdata: {}\r\r");
    parser.end();
    expect(seen).toEqual([
      { event: "stage", data: { name: "received" } },
      { event: "done", data: {} },
    ]);
  });

  it("reports bad JSON and schema failures without throwing", () => {
    const invalid: string[] = [];
    const parser = createEventStreamParser(
      () => undefined,
      (info) => invalid.push(`${info.name}:${info.reason}`),
    );
    parser.push('event: card\ndata: {"heard":\n\nevent: stage\ndata: {"name":"thinking"}\n\n');
    parser.end();
    expect(invalid).toEqual(["card:bad_json", "stage:invalid"]);
  });

  it("cancels the body when the reader stops early", async () => {
    let cancelled = false;
    const first = encodeEventBytes(allEvents[0]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const ev of readEventStream(stream)) {
      expect(ev.event).toBe("stage");
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe("errors", () => {
  it("builds a complete pre-stream error response", async () => {
    const res = errorEventResponse("rate_limited", { retryAfterSec: 120 });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(isEventStream(res)).toBe(true);
    const events = await collect(res.body as ReadableStream<Uint8Array>);
    expect(events).toEqual([
      { event: "error", data: { code: "rate_limited", retryable: true, stored: false, retryAfterSec: 120 } },
      { event: "done", data: {} },
    ]);
  });

  it("covers every code with info, copy and a status mapping", () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_INFO[code].key).toBe(`error.${code}`);
      expect(ERROR_COPY_EN[code].length).toBeGreaterThan(0);
      expect(errorData(code).stored).toBe(false);
    }
    expect(errorCodeFromStatus(413)).toBe("too_large");
    expect(errorCodeFromStatus(429)).toBe("rate_limited");
    expect(errorCodeFromStatus(504)).toBe("timeout");
    expect(errorCodeFromStatus(502)).toBe("server_error");
    expect(errorCodeFromStatus(404)).toBe("bad_request");
    expect(errorCodeFromFailure("no_token")).toBe("timeout");
    expect(errorCodeFromFailure("bad_json")).toBe("provider_error");
    expect(errorCodeFromFailure("not_configured")).toBe("not_configured");
    for (const failure of PROVIDER_FAILURES) expect(ERROR_CODES).toContain(errorCodeFromFailure(failure));
  });

  it("keeps every English string inside the writing rules", () => {
    const copy = [
      ...Object.values(ERROR_COPY_EN),
      ...Object.values(STAGE_COPY_EN),
      ...Object.values(ERROR_ACTION_LABELS_EN).flat(),
    ];
    for (const text of copy) expect(copyRuleProblems(text), text).toEqual([]);
  });
});

describe("WAV body", () => {
  it("accepts 16 kHz mono PCM16 and reports its length", () => {
    const check = checkClipWav(makeWav({ seconds: 30 }));
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.wav.seconds).toBe(30);
      expect(check.wav.dataBytes).toBe(960_000);
      expect(check.wav.dataOffset).toBe(44);
    }
  });

  it("walks past other chunks with pad bytes", () => {
    const info = inspectWav(makeWav({ seconds: 2, listChunk: true }).buffer);
    expect(info.ok && info.dataOffset).toBe(58);
  });

  it("rejects the wrong format with a reason", () => {
    expect(checkClipWav(makeWav({ sampleRate: 24_000 }))).toMatchObject({ ok: false, problem: "wrong_rate" });
    expect(checkClipWav(makeWav({ channels: 2 }))).toMatchObject({ ok: false, problem: "not_mono" });
    expect(checkClipWav(makeWav({ bits: 8 }))).toMatchObject({ ok: false, problem: "not_16bit" });
    expect(checkClipWav(makeWav({ formatTag: 3 }))).toMatchObject({ ok: false, problem: "not_pcm" });
    expect(checkClipWav(makeWav({ seconds: 0.5 }))).toMatchObject({ ok: false, code: "bad_audio", problem: "too_short" });
    expect(checkClipWav(makeWav({ seconds: 126 }))).toMatchObject({ ok: false, code: "too_large", problem: "too_long" });
    expect(checkClipWav(new Uint8Array(10))).toMatchObject({ ok: false, problem: "too_small" });
    const notRiff = makeWav();
    notRiff[0] = 0x58;
    expect(checkClipWav(notRiff)).toMatchObject({ ok: false, problem: "not_riff" });
  });

  it("keeps the longest clip under the body cap", () => {
    const longest = LIMITS.wavHeaderBytes + LIMITS.maxClipSec * LIMITS.bytesPerSecond;
    expect(longest).toBeLessThan(LIMITS.maxBodyBytes);
    expect(LIMITS.maxBodyBytes).toBeLessThan(4_500_000);
  });
});

describe("time", () => {
  const at = Date.UTC(2026, 10, 2, 15, 42, 40, 123); // 2026-11-02 15:42:40.123 UTC
  it("writes local ISO time with the offset", () => {
    expect(toLocalIso(at, -300)).toBe("2026-11-02T10:42:40.123-05:00");
    expect(toLocalIso(at, 540)).toBe("2026-11-03T00:42:40.123+09:00");
    expect(toLocalIso(at, 330)).toBe("2026-11-02T21:12:40.123+05:30");
    expect(toLocalIso(at)).toMatch(/^2026-11-0[23]T\d{2}:\d{2}:\d{2}\.123[+-]\d{2}:\d{2}$/);
  });
  it("names the weekday of the local date", () => {
    expect(weekdayOfIso("2026-11-02T10:42:40.123-05:00")).toBe("Monday");
    expect(weekdayOfIso("2026-11-03T00:42:40.123+09:00")).toBe("Tuesday");
    expect(weekdayOfIso("yesterday")).toBeNull();
  });
});

describe("card assembly and health", () => {
  it("joins a wire card with client meta and drops server extras", () => {
    const card = toCard(wire, {
      id: "c1",
      pressedAt: meta.pressedAt,
      windowSec: 30,
      sentSec: 30,
      cardLang: "ja",
      source: "tab",
      ms: { total: 3400, firstToken: 2400, upload: 300 },
      bytesSent: 960_044,
    });
    expect(Card.parse(card)).toEqual(card);
    expect(card.meta.route).toBe("open_weights");
    expect(card.meta.model).toBe("meta-models/muse-spark-open-1026");
    expect(card.meta).not.toHaveProperty("timing");
    expect(card.meta).not.toHaveProperty("parse");
    expect(card.summary).toEqual(body.summary);
  });

  it("parses a health response", () => {
    const health = HealthResponse.parse({
      ok: true,
      v: 1,
      live: false,
      paused: "live_off",
      defaultRoute: "auto",
      mock: false,
      routes: {
        open_weights: { configured: false, model: "meta-models/muse-spark-open-1026", provider: "Baseten" },
        meta_api: { configured: false, model: "muse-voice-transcribe-1.0 + muse-spark-1.3", provider: "Meta Model API" },
      },
      limits: { maxBodyBytes: LIMITS.maxBodyBytes, maxClipSec: LIMITS.maxClipSec, perHour: 30, hardCapMs: LIMITS.hardCapMs },
    });
    expect(health.paused).toBe("live_off");
  });
});
