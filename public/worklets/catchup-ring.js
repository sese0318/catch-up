// Catch Up ring buffer, running on the audio rendering thread (AudioWorkletGlobalScope).
// Holds the most recent N seconds of mono audio in memory only. Nothing here is stored or sent.
// Messages in
//   { type: "snapshot", id, seconds }   copy of the newest audio, never older than the last gap
//   { type: "gap" }                     memory restarts here (interruption, track mute)
//   { type: "clear", epoch }            zero everything, later messages carry this epoch
//   { type: "feed", on }                stop or resume writing (a finished sample stops it)
// Messages out
//   { type: "level", epoch, rms, peak, filled, sinceGap, sampleRate }   about 10 per second
//   { type: "snapshot", id, epoch, sampleRate, frames, gapCut, pcm }    pcm is transferred
//   { type: "cleared", epoch }
class CatchUpRing extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const seconds = Math.max(1, Math.min(300, Number(opts.seconds) || 120));
    this.capacity = Math.ceil(sampleRate * seconds);
    this.buf = new Float32Array(this.capacity);
    this.w = 0; // next write index
    this.filled = 0; // valid frames, capped at capacity
    this.sinceGap = 0; // frames written since the last gap or clear
    this.feeding = true;
    this.epoch = 0;
    this.levelEvery = Math.max(1, Math.round(sampleRate / 10));
    this.resetLevel();
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(msg) {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "snapshot") this.snapshot(msg);
    else if (msg.type === "gap") this.sinceGap = 0;
    else if (msg.type === "clear") this.clear(msg.epoch);
    else if (msg.type === "feed") {
      this.feeding = msg.on !== false;
      this.resetLevel();
    }
  }

  snapshot(msg) {
    const seconds = Number(msg.seconds);
    let want = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * sampleRate) : this.filled;
    want = Math.min(want, this.filled);
    let gapCut = false;
    if (this.sinceGap < want) {
      want = this.sinceGap;
      gapCut = true;
    }
    const pcm = new Float32Array(want);
    if (want > 0) {
      const start = (this.w - want + this.capacity) % this.capacity;
      const first = Math.min(want, this.capacity - start);
      pcm.set(this.buf.subarray(start, start + first), 0);
      if (first < want) pcm.set(this.buf.subarray(0, want - first), first);
    }
    this.port.postMessage(
      { type: "snapshot", id: msg.id, epoch: this.epoch, sampleRate, frames: want, gapCut, pcm },
      [pcm.buffer],
    );
  }

  clear(epoch) {
    this.buf.fill(0);
    this.w = 0;
    this.filled = 0;
    this.sinceGap = 0;
    if (typeof epoch === "number") this.epoch = epoch;
    this.resetLevel();
    this.port.postMessage({ type: "cleared", epoch: this.epoch });
  }

  resetLevel() {
    this.levelCount = 0;
    this.levelSumSq = 0;
    this.levelPeak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.feeding || !input || input.length === 0) return true; // stay alive with nothing connected
    const ch = input[0]; // channelCount 1 with explicit mode gives one downmixed channel
    const n = ch ? ch.length : 0; // never assume 128
    if (n === 0) return true;

    const src = n > this.capacity ? ch.subarray(n - this.capacity) : ch;
    const m = src.length;
    const first = Math.min(m, this.capacity - this.w);
    this.buf.set(first === m ? src : src.subarray(0, first), this.w);
    if (first < m) this.buf.set(src.subarray(first), 0);
    this.w = (this.w + m) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + m);
    this.sinceGap = Math.min(this.capacity, this.sinceGap + m);

    // The level meter is also the only reliable sign that audio really flows.
    for (let i = 0; i < n; i++) {
      const s = ch[i];
      this.levelSumSq += s * s;
      const a = s < 0 ? -s : s;
      if (a > this.levelPeak) this.levelPeak = a;
    }
    this.levelCount += n;
    if (this.levelCount >= this.levelEvery) {
      this.port.postMessage({
        type: "level",
        epoch: this.epoch,
        rms: Math.sqrt(this.levelSumSq / this.levelCount),
        peak: this.levelPeak,
        filled: this.filled,
        sinceGap: this.sinceGap,
        sampleRate,
      });
      this.resetLevel();
    }
    return true;
  }
}

registerProcessor("catchup-ring", CatchUpRing);
