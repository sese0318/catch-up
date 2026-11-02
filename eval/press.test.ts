import { describe, expect, it } from "vitest";
import {
  META_HEADER,
  SSE_HEADERS,
  decodeMetaHeader,
  encodeEvent,
  errorEventResponse,
  type PressMeta,
  type StreamEvent,
  type WireCard,
} from "@/lib/protocol";
import { checkLocalBaseUrl, pressTimeLabel } from "./run";
import { buildCardRequest, collectPress } from "./press";

const meta: PressMeta = {
  v: 1,
  pressedAt: "2026-11-02T10:30:00.000-05:00",
  tz: "America/New_York",
  cardLang: "ja",
  meetingLang: "en",
  windowSec: 30,
  sentSec: 18,
  source: "sample",
  names: ["Sam", "サム"],
  route: "open_weights",
  sessionId: "eval-session-0001",
};

const card: WireCard = {
  heard: "clear",
  ask: { to: "you", text: "木曜日のデモでいいか聞かれました" },
  say: { text: "Just to check, Thursday for the demo?", lang: "en", gloss: "木曜日のデモで確認" },
  summary: ["木曜か月曜のデモについて聞かれました。"],
  facts: [{ kind: "date", text: "11月5日(木)" }],
  meta: { route: "open_weights", model: "meta-models/muse-spark-open-1026", parse: "clean", timing: { totalMs: 2900, firstTokenMs: 1100, bytes: 576_044 } },
};

/** A response that streams the given events, split into small chunks like a network would. */
function streamOf(events: StreamEvent[], status = 200): Response {
  const text = events.map(encodeEvent).join("");
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
      controller.close();
    },
  });
  return new Response(body, { status, headers: SSE_HEADERS });
}

/** A clock that moves 100 ms every time it is read. */
function clock(): () => number {
  let t = 0;
  return () => (t += 100);
}

describe("buildCardRequest", () => {
  it("posts the raw WAV with the meta header, like the press pipeline", async () => {
    const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
    const req = buildCardRequest("http://localhost:3000", wav, meta);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:3000/api/card");
    expect(req.headers.get("content-type")).toBe("audio/wav");
    const decoded = decodeMetaHeader(req.headers.get(META_HEADER));
    expect(decoded).toEqual({ ok: true, meta });
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(wav);
  });
});

describe("collectPress", () => {
  it("times the writing stage and the card from the request start", async () => {
    const res = streamOf([
      { event: "stage", data: { name: "received", ms: 40 } },
      { event: "stage", data: { name: "writing", ms: 1100 } },
      { event: "card", data: card },
      { event: "done", data: {} },
    ]);
    const got = await collectPress(res, clock(), 0);
    expect(got.stages.map((s) => s.name)).toEqual(["received", "writing"]);
    expect(got.firstTokenMs).toBe(200);
    expect(got.cardMs).toBe(300);
    expect(got.card).toEqual(card);
    expect(got.error).toBeNull();
    expect(got.failure).toBeNull();
  });

  it("keeps the error of a stream that ends without a card", async () => {
    const got = await collectPress(errorEventResponse("rate_limited", { retryAfterSec: 60 }), clock(), 0);
    expect(got.httpStatus).toBe(429);
    expect(got.card).toBeNull();
    expect(got.error).toMatchObject({ code: "rate_limited", retryAfterSec: 60, stored: false });
    expect(got.failure).toBeNull();
  });

  it("maps a response that is not an event stream through its status", async () => {
    const got = await collectPress(new Response("Request Entity Too Large", { status: 413 }), clock(), 0);
    expect(got.error).toMatchObject({ code: "too_large" });
    expect(got.failure).toBe("not_event_stream");
  });

  it("flags a stream with neither card nor error, and counts invalid events", async () => {
    const res = new Response("event: card\ndata: {\"heard\":\"loud\"}\n\nevent: done\ndata: {}\n\n", { headers: SSE_HEADERS });
    const got = await collectPress(res, clock(), 0);
    expect(got.invalidEvents).toBe(1);
    expect(got.failure).toBe("no_card");
  });

  it("flags a second card", async () => {
    const got = await collectPress(streamOf([{ event: "card", data: card }, { event: "card", data: card }]), clock(), 0);
    expect(got.card).toEqual(card);
    expect(got.failure).toBe("second_card");
  });
});

describe("runner guards", () => {
  it("talks to localhost or 127.0.0.1 only", () => {
    expect(checkLocalBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(checkLocalBaseUrl("http://127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
    expect(() => checkLocalBaseUrl("https://catch-up.vercel.app")).toThrow(/localhost or 127.0.0.1 only/);
    expect(() => checkLocalBaseUrl("http://192.168.1.20:3000")).toThrow(/localhost or 127.0.0.1 only/);
    expect(() => checkLocalBaseUrl("http://localhost.example.com")).toThrow(/localhost or 127.0.0.1 only/);
    expect(() => checkLocalBaseUrl("ftp://localhost")).toThrow(/http or https/);
    expect(() => checkLocalBaseUrl("not a url")).toThrow(/not a URL/);
  });

  it("names the scripts' press time in words", () => {
    expect(pressTimeLabel({ referenceTime: "2026-11-02T10:30:00.000-05:00", tz: "America/New_York" })).toBe(
      "Mon Nov 2 2026 at 10:30 in `America/New_York`, unless a clip sets its own",
    );
  });
});
