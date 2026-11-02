import { describe, expect, it } from "vitest";
import { feed, loadRingProcessor } from "./worklet-harness";

type Msg = Record<string, unknown> & { type: string };

function ramp(from: number, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = (from + i) / 100_000;
  return out;
}

function last(outbox: unknown[], type: string): Msg {
  const found = [...outbox].reverse().find((m) => (m as Msg).type === type);
  if (!found) throw new Error(`no ${type} message`);
  return found as Msg;
}

describe("catchup-ring worklet", () => {
  const rate = 1000;
  const ring = loadRingProcessor(rate);

  it("keeps only the newest audio and snapshots it in order across the wrap", () => {
    const { processor, outbox } = ring.create(2); // 2000 frames
    expect(processor.capacity).toBe(2000);
    feed(processor, ramp(0, 3500));
    expect(processor.filled).toBe(2000);
    processor.port.onmessage!({ data: { type: "snapshot", id: 7, seconds: 120 } });
    const snap = last(outbox, "snapshot");
    expect(snap.id).toBe(7);
    expect(snap.frames).toBe(2000);
    expect(snap.sampleRate).toBe(rate);
    expect(snap.gapCut).toBe(false);
    const pcm = snap.pcm as Float32Array;
    expect(pcm[0]).toBeCloseTo(1500 / 100_000, 6);
    expect(pcm[1999]).toBeCloseTo(3499 / 100_000, 6);
    for (let i = 1; i < pcm.length; i++) expect(pcm[i]).toBeGreaterThan(pcm[i - 1]);
  });

  it("returns only what it holds, and the tail when asked for less", () => {
    const { processor, outbox } = ring.create(2);
    feed(processor, ramp(0, 700));
    processor.port.onmessage!({ data: { type: "snapshot", id: 1, seconds: 120 } });
    expect(last(outbox, "snapshot").frames).toBe(700);
    processor.port.onmessage!({ data: { type: "snapshot", id: 2, seconds: 0.25 } });
    const tail = last(outbox, "snapshot");
    expect(tail.frames).toBe(250);
    expect((tail.pcm as Float32Array)[0]).toBeCloseTo(450 / 100_000, 6);
  });

  it("never reaches back past a gap", () => {
    const { processor, outbox } = ring.create(2);
    feed(processor, ramp(0, 1500));
    processor.port.onmessage!({ data: { type: "gap" } });
    feed(processor, ramp(5000, 300), 100);
    processor.port.onmessage!({ data: { type: "snapshot", id: 3, seconds: 120 } });
    const snap = last(outbox, "snapshot");
    expect(snap.frames).toBe(300);
    expect(snap.gapCut).toBe(true);
    expect((snap.pcm as Float32Array)[0]).toBeCloseTo(5000 / 100_000, 6);
  });

  it("clears to zero and stamps later messages with the new epoch", () => {
    const { processor, outbox } = ring.create(2);
    feed(processor, ramp(1, 1200));
    processor.port.onmessage!({ data: { type: "clear", epoch: 4 } });
    expect(processor.filled).toBe(0);
    expect(processor.sinceGap).toBe(0);
    expect(processor.buf.every((v) => v === 0)).toBe(true);
    expect(last(outbox, "cleared").epoch).toBe(4);
    feed(processor, ramp(1, 200));
    expect(last(outbox, "level").epoch).toBe(4);
  });

  it("reports level about 10 times a second with filled and sinceGap frames", () => {
    const { processor, outbox } = ring.create(2);
    const tone = new Float32Array(1000).fill(0.5);
    feed(processor, tone);
    const levels = outbox.filter((m) => (m as Msg).type === "level") as Msg[];
    expect(levels.length).toBeGreaterThanOrEqual(7);
    expect(levels.length).toBeLessThanOrEqual(10);
    const level = levels[levels.length - 1];
    expect(level.rms).toBeCloseTo(0.5, 5);
    expect(level.peak).toBeCloseTo(0.5, 5);
    expect(level.filled).toBe(level.sinceGap);
    expect(level.sampleRate).toBe(rate);
  });

  it("stops writing and reporting while feed is off", () => {
    const { processor, outbox } = ring.create(2);
    feed(processor, ramp(0, 500));
    processor.port.onmessage!({ data: { type: "feed", on: false } });
    const before = outbox.length;
    feed(processor, ramp(0, 800));
    expect(processor.filled).toBe(500);
    expect(outbox.length).toBe(before);
    processor.port.onmessage!({ data: { type: "feed", on: true } });
    feed(processor, ramp(0, 100));
    expect(processor.filled).toBe(600);
  });

  it("stays alive with nothing connected and handles odd block sizes", () => {
    const { processor } = ring.create(2);
    expect(processor.process([])).toBe(true);
    expect(processor.process([[]])).toBe(true);
    expect(processor.process([[new Float32Array(0)]])).toBe(true);
    feed(processor, ramp(0, 1000), 97);
    expect(processor.filled).toBe(1000);
  });

  it("transfers the snapshot buffer instead of copying it twice", () => {
    const { processor, outbox } = ring.create(2);
    const transfers: unknown[][] = [];
    const post = processor.port.postMessage.bind(processor.port);
    processor.port.postMessage = (message, transfer) => {
      transfers.push(transfer ?? []);
      post(message, transfer);
    };
    feed(processor, ramp(0, 100), 100);
    processor.port.onmessage!({ data: { type: "snapshot", id: 9, seconds: 1 } });
    const snap = last(outbox, "snapshot");
    expect(transfers[transfers.length - 1]).toEqual([(snap.pcm as Float32Array).buffer]);
  });
});
