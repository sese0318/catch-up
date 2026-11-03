// Catch Up eval runner. npm run eval -- --help lists the options.
// In process by default, through handleCardRequest with the hourly limit off and one client key per
// pass. With --base-url it talks to a local server only, never the deployed app, so it never spends
// the public daily cap. Keys come from .env.local and are never printed. Raw results stay in
// eval/results/raw (git-ignored), and eval/results/summary.md holds the table for the README.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { CARD_LANGS, routeAModelLabel, type CardLang } from "@/lib/card/schema";
import {
  HEALTH_ENDPOINT,
  HealthResponse,
  LIMITS,
  MOCK_MODES,
  ROUTE_PREFERENCES,
  checkClipWav,
  toLocalIso,
  weekdayOfIso,
  type MockMode,
  type RoutePreference,
} from "@/lib/protocol";
import { LOCAL_CLIENT_KEY, type CardHandlerDeps, type PressLogEntry, type ServerEnv } from "@/lib/providers/types";
import { CLIPS_PATH, CLIP_SETS, EVAL_DIR, clipsInSet, loadClipsFile, mockFixtureFor, pressMetaFor, type ClipSet, type ClipsFile, type EvalClip } from "./clips";
import { renderSummaryMarkdown, summarizeRoute, type PressRecord, type RouteSummary } from "./metrics";
import { buildCardRequest, collectPressWithTimeout, type CollectedPress } from "./press";

const ROOT = resolve(EVAL_DIR, "..");
const DEFAULT_AUDIO_DIR = join(EVAL_DIR, "clips");
const DEFAULT_OUT_DIR = join(EVAL_DIR, "results");
const CLIENT_TIMEOUT_MS = LIMITS.hardCapMs + 5_000;
const LIVE_ORDER = ["open_weights", "meta_api", "auto"] as const;

const HELP = `Catch Up eval

  npm run eval -- [options]

  --route LIST       open_weights, meta_api, auto or mock, comma separated. Default every live route with a key
  --runs N           runs per route, default 3
  --set NAME         eval (the 10 scenes and the control clip, default), samples or all
  --clip IDS         only these clip ids, comma separated
  --card-lang LANG   en, ja or zh for every clip instead of each script's own
  --base-url URL     send to a local server (localhost or 127.0.0.1 only) started with RATE_LIMIT_PER_HOUR=0
  --audio-dir DIR    where the clip WAV files are, default eval/clips
  --mock-mode MODE   ok, slow, error or badjson for the mock route, default ok
  --press-time WHEN  script (default) or now. Use now for runs that save cached sample cards
  --out DIR          results folder, default eval/results
  --dry-run          check the scripts, the audio and the headers, then stop without sending
  --summary-only     rebuild the matching summary (uses --set and --press-time)
  --help             show this

Make the synthetic clips first with
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/make-synthetic-clips.ps1
A keyless smoke run needs ALLOW_MOCK=1 and --route mock.
`;

/** One press in a raw file. The server log line holds timings and status only. */
export interface RawRecord extends PressRecord {
  pressedAt?: string; // the press time sent in the header
  serverLog?: PressLogEntry;
}

export interface RawRun {
  kind: "catchup-eval-raw";
  version: 1;
  startedAt: string;
  finishedAt: string;
  route: RoutePreference;
  mode: "in_process" | "http";
  baseUrl?: string;
  pressTime?: "script" | "now";
  runs: number;
  set: ClipSet;
  clipIds: string[];
  cardLang: CardLang | null;
  audio: { dir: string; synthetic: boolean };
  models: Record<string, string>;
  clipsSha256: string;
  records: RawRecord[];
}

class SetupError extends Error {}

function fail(message: string): never {
  throw new SetupError(message);
}

function rel(path: string): string {
  return relative(ROOT, path).replace(/\\/g, "/");
}

function listArg(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Only localhost or 127.0.0.1, so the eval never spends the deployed app's daily cap. */
export function checkLocalBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`--base-url ${value} is not a URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("--base-url needs http or https.");
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    fail("--base-url takes localhost or 127.0.0.1 only. The eval never runs against the deployed app.");
  }
  return url.origin;
}

function loadLocalEnv(): void {
  const file = join(ROOT, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

interface Clip {
  clip: EvalClip;
  wav: Uint8Array;
  seconds: number;
}

function loadAudio(clips: readonly EvalClip[], dir: string): Clip[] {
  const missing: string[] = [];
  const out: Clip[] = [];
  for (const clip of clips) {
    const file = join(dir, `${clip.id}.wav`);
    if (!existsSync(file)) {
      missing.push(clip.id);
      continue;
    }
    const wav = new Uint8Array(readFileSync(file));
    const check = checkClipWav(wav);
    if (!check.ok) fail(`${rel(file)} is not a usable clip (${check.problem}).`);
    out.push({ clip, wav, seconds: check.wav.seconds });
  }
  if (missing.length > 0) {
    fail(
      `No audio for ${missing.join(", ")} in ${rel(dir)}. Make it with\n  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/make-synthetic-clips.ps1`,
    );
  }
  return out;
}

function isSyntheticDir(dir: string): boolean {
  try {
    const timings = JSON.parse(readFileSync(join(dir, "timings.json"), "utf8")) as { synthetic?: unknown };
    return timings.synthetic === true;
  } catch {
    return false;
  }
}

function stampOf(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function seconds(ms: number | null): string {
  return ms === null ? "none" : `${(ms / 1000).toFixed(1)} s`;
}

interface Target {
  mode: "in_process" | "http";
  baseUrl?: string;
  configured: Record<RoutePreference, boolean>;
  models: Record<string, string>;
  send(request: Request, clientKey: string, log: (entry: PressLogEntry) => void): Promise<Response>;
}

async function inProcessTarget(): Promise<Target> {
  loadLocalEnv();
  const [{ handleCardRequest }, { readServerEnv }] = await Promise.all([
    import("@/lib/server/handle-card"),
    import("@/lib/server/env"),
  ]);
  let env: ServerEnv;
  try {
    env = { ...readServerEnv(), ratePerHour: 0 };
  } catch (error) {
    return fail(`readServerEnv failed (${error instanceof Error ? error.message : "unknown"}). Is the server lane in place yet?`);
  }
  const live = env.liveEnabled;
  return {
    mode: "in_process",
    configured: {
      open_weights: live && env.baseten.apiKey !== null,
      meta_api: live && env.meta.apiKey !== null,
      auto: live && (env.baseten.apiKey !== null || env.meta.apiKey !== null),
      mock: env.allowMock,
    },
    models: { open_weights: env.baseten.model, meta_api: routeAModelLabel(env.meta.asrModel, env.meta.cardModel) },
    send: (request, clientKey, log) => {
      const deps: CardHandlerDeps = { env, clientKey: () => clientKey, log };
      return handleCardRequest(request, deps);
    },
  };
}

async function httpTarget(baseUrl: string): Promise<Target> {
  let health: HealthResponse;
  try {
    const res = await fetch(new URL(HEALTH_ENDPOINT, baseUrl));
    health = HealthResponse.parse(await res.json());
  } catch {
    return fail(`No health answer from ${baseUrl}${HEALTH_ENDPOINT}. Is the local server running?`);
  }
  if (health.limits.perHour !== 0) fail("That server limits presses per hour. Start it with RATE_LIMIT_PER_HOUR=0 for the eval.");
  return {
    mode: "http",
    baseUrl,
    configured: {
      open_weights: health.live && health.routes.open_weights.configured,
      meta_api: health.live && health.routes.meta_api.configured,
      auto: health.live && (health.routes.open_weights.configured || health.routes.meta_api.configured),
      mock: health.mock,
    },
    models: { open_weights: health.routes.open_weights.model, meta_api: health.routes.meta_api.model },
    send: (request) => fetch(request),
  };
}

function pickRoutes(asked: string[], target: Target): RoutePreference[] {
  for (const r of asked) {
    if (!(ROUTE_PREFERENCES as readonly string[]).includes(r)) fail(`Unknown route ${r}. Use ${ROUTE_PREFERENCES.join(", ")}.`);
  }
  const wanted = (asked.length > 0 ? asked : [...LIVE_ORDER]) as RoutePreference[];
  const ready = wanted.filter((r) => target.configured[r]);
  for (const r of wanted.filter((r) => !target.configured[r])) {
    console.log(r === "mock" ? "Skipping mock, it needs ALLOW_MOCK=1 outside production." : `Skipping ${r}, it has no key or live calls are off.`);
  }
  if (ready.length === 0) {
    fail("No route can run. Add keys to .env.local, or try a keyless smoke run with ALLOW_MOCK=1 and --route mock.");
  }
  return ready;
}

interface RunOptions {
  route: RoutePreference;
  runs: number;
  clips: Clip[];
  file: ClipsFile;
  cardLang: CardLang | null;
  mockMode: MockMode;
  pressTime: "script" | "now";
  target: Target;
  stamp: string;
}

async function runRoute(o: RunOptions): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (let run = 1; run <= o.runs; run++) {
    const sessionId = randomUUID();
    const clientKey = `${LOCAL_CLIENT_KEY}-eval-${o.stamp}-${o.route}-${run}`;
    for (const { clip, wav, seconds: clipSec } of o.clips) {
      const meta = pressMetaFor(o.file, clip, {
        route: o.route,
        sessionId,
        sentSec: clipSec,
        cardLang: o.cardLang ?? undefined,
        mock: o.route === "mock" ? { mode: o.mockMode, fixture: mockFixtureFor(clip) } : undefined,
        ...(o.pressTime === "now" ? { pressedAt: toLocalIso(Date.now()), tz: localZone } : {}),
      });
      const logs: PressLogEntry[] = [];
      const controller = new AbortController();
      const request = buildCardRequest(o.target.baseUrl ?? "http://localhost", wav, meta, controller.signal);
      const t0 = performance.now();
      let collected: CollectedPress;
      try {
        collected = await collectPressWithTimeout(
          () => o.target.send(request, clientKey, (entry) => logs.push(entry)),
          controller,
          () => performance.now(),
          t0,
          CLIENT_TIMEOUT_MS,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "not implemented") {
          fail("handleCardRequest is still a stub. Run the eval once the server lane has landed.");
        }
        collected = {
          httpStatus: 0,
          stages: [],
          firstTokenMs: null,
          cardMs: null,
          totalMs: performance.now() - t0,
          card: null,
          error: null,
          failure: o.target.mode === "http" ? "network" : "exception",
          invalidEvents: 0,
        };
      }
      const record: RawRecord = {
        clipId: clip.id,
        route: o.route,
        run,
        cardLang: meta.cardLang,
        sentSec: meta.sentSec,
        bytes: wav.byteLength,
        pressedAt: meta.pressedAt,
        ...collected,
        ...(logs.length > 0 ? { serverLog: logs[logs.length - 1] } : {}),
      };
      records.push(record);
      const card = record.card;
      const outcome = card
        ? `card in ${seconds(record.cardMs)}, first token ${seconds(record.firstTokenMs)}, ask ${card.ask.to} (script ${clip.gold.askTo})${card.meta.fallbackFrom ? ", fell back" : ""}`
        : `no card (${record.error?.code ?? record.failure ?? "unknown"})`;
      console.log(`${o.route.padEnd(12)} run ${run} of ${o.runs}  ${clip.id.padEnd(24)} ${outcome}`);
    }
  }
  return records;
}

function readRawRuns(dir: string): { file: string; raw: RawRun }[] {
  if (!existsSync(dir)) return [];
  const out: { file: string; raw: RawRun }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as RawRun;
      if (raw.kind === "catchup-eval-raw" && raw.version === 1) out.push({ file: join(dir, name), raw });
    } catch {
      console.log(`Skipping ${name}, it is not a raw eval file.`);
    }
  }
  return out;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The scripts' press time in words, for example Mon Nov 2 2026 at 10:30. */
export function pressTimeLabel(file: Pick<ClipsFile, "referenceTime" | "tz">): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(file.referenceTime);
  if (!m) return file.referenceTime;
  const weekday = (weekdayOfIso(file.referenceTime) ?? "").slice(0, 3);
  return `${weekday} ${MONTH_NAMES[Number(m[2]) - 1]} ${Number(m[3])} ${m[1]} at ${m[4]}:${m[5]} in \`${file.tz}\`, unless a clip sets its own`;
}

export interface RawRunFile {
  file: string;
  raw: RawRun;
}

/** Compare only matching datasets, and keep sample/cache runs out of the benchmark. */
export function selectSummaryRuns(
  entries: readonly RawRunFile[],
  set: ClipSet,
  pressTime: "script" | "now",
): RawRunFile[] {
  const candidates = entries.filter(({ raw }) => raw.set === set && (raw.pressTime ?? "script") === pressTime);
  const latest = candidates.reduce<RawRunFile | null>(
    (newest, entry) => !newest || entry.raw.startedAt > newest.raw.startedAt ? entry : newest,
    null,
  );
  if (!latest) return [];
  const cohort = (raw: RawRun) => JSON.stringify([
    [...raw.clipIds].sort(), raw.cardLang, raw.audio.dir, raw.audio.synthetic, raw.clipsSha256,
    raw.runs, raw.mode, raw.baseUrl ?? null,
  ]);
  const wanted = cohort(latest.raw);
  const newest = new Map<RoutePreference, RawRunFile>();
  for (const entry of candidates) {
    if (cohort(entry.raw) !== wanted) continue;
    const current = newest.get(entry.raw.route);
    if (!current || entry.raw.startedAt > current.raw.startedAt) newest.set(entry.raw.route, entry);
  }
  const order: RoutePreference[] = ["open_weights", "meta_api", "auto", "mock"];
  return order.map((r) => newest.get(r)).filter((entry): entry is RawRunFile => entry !== undefined);
}

export function summaryStem(set: ClipSet, pressTime: "script" | "now"): string {
  return set === "eval" && pressTime === "script" ? "summary" : `${set}-${pressTime}-summary`;
}

/** Rebuild one purpose's summary from the newest coherent dataset across routes. */
function writeSummary(outDir: string, file: ClipsFile, set: ClipSet, pressTime: "script" | "now"): RouteSummary[] {
  const rawDir = join(outDir, "raw");
  const chosen = selectSummaryRuns(readRawRuns(rawDir), set, pressTime);
  if (chosen.length === 0) fail(`No ${set} results with ${pressTime} press time in ${rel(rawDir)} yet.`);
  const routes = chosen.map(({ raw }) => summarizeRoute(raw.route, raw.records, file.clips));
  const synthetic = chosen.map(({ raw }) => raw.audio.synthetic);
  const audio = synthetic.every(Boolean)
    ? "synthetic Windows voices reading the scripts in `eval/clips.json`"
    : synthetic.some(Boolean)
      ? "synthetic voices for some routes and recordings for others, see Sources"
      : `recordings of the scripts in \`eval/clips.json\` from \`${chosen[0].raw.audio.dir}\``;
  const runs = [...new Set(chosen.map(({ raw }) => raw.runs))];
  const markdown = renderSummaryMarkdown({
    generatedAt: new Date().toISOString(),
    audio,
    runsPerRoute: Math.max(...runs),
    pressTime: pressTimeLabel(file),
    realClockRoutes: chosen.filter(({ raw }) => raw.pressTime === "now").map(({ raw }) => raw.route),
    sources: chosen.map(({ file: f }) => rel(f)),
    routes,
  });
  mkdirSync(outDir, { recursive: true });
  const stem = summaryStem(set, pressTime);
  writeFileSync(join(outDir, `${stem}.md`), markdown);
  writeFileSync(join(outDir, `${stem}.json`), `${JSON.stringify({ generatedAt: new Date().toISOString(), routes }, null, 2)}\n`);
  console.log(`Wrote ${rel(join(outDir, `${stem}.md`))} and ${stem}.json.`);
  return routes;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      route: { type: "string" },
      runs: { type: "string" },
      set: { type: "string" },
      clip: { type: "string" },
      "card-lang": { type: "string" },
      "base-url": { type: "string" },
      "audio-dir": { type: "string" },
      "mock-mode": { type: "string" },
      "press-time": { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean" },
      "summary-only": { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const file = loadClipsFile(CLIPS_PATH);
  const outDir = resolve(ROOT, values.out ?? DEFAULT_OUT_DIR);
  const set = (values.set ?? "eval") as ClipSet;
  if (!CLIP_SETS.includes(set)) fail(`Unknown set ${set}. Use ${CLIP_SETS.join(", ")}.`);
  const pressTime = values["press-time"] ?? "script";
  if (pressTime !== "script" && pressTime !== "now") fail("--press-time takes script or now.");
  if (values["summary-only"]) {
    writeSummary(outDir, file, set, pressTime);
    return 0;
  }
  let clips = clipsInSet(file, set);
  const only = listArg(values.clip);
  if (only.length > 0) {
    const unknown = only.filter((id) => !file.clips.some((c) => c.id === id));
    if (unknown.length > 0) fail(`Unknown clip ${unknown.join(", ")}.`);
    clips = file.clips.filter((c) => only.includes(c.id));
  }
  const cardLangArg = values["card-lang"];
  if (cardLangArg !== undefined && !(CARD_LANGS as readonly string[]).includes(cardLangArg)) fail(`--card-lang takes ${CARD_LANGS.join(", ")}.`);
  const cardLang = (cardLangArg ?? null) as CardLang | null;
  const runs = Number(values.runs ?? 3);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) fail("--runs takes a whole number from 1 to 10.");
  const mockMode = (values["mock-mode"] ?? "ok") as MockMode;
  if (!MOCK_MODES.includes(mockMode)) fail(`--mock-mode takes ${MOCK_MODES.join(", ")}.`);
  const audioDir = resolve(ROOT, values["audio-dir"] ?? DEFAULT_AUDIO_DIR);
  const audio = loadAudio(clips, audioDir);

  if (values["dry-run"]) {
    for (const { clip, seconds: s } of audio) {
      pressMetaFor(file, clip, { route: "mock", sessionId: randomUUID(), sentSec: s, cardLang: cardLang ?? undefined });
      console.log(`${clip.id.padEnd(24)} ${s.toFixed(1)} s  ask ${clip.gold.askTo}  ${clip.scene}`);
    }
    console.log(`${audio.length} clips ready in ${rel(audioDir)}${isSyntheticDir(audioDir) ? " (synthetic voices)" : ""}. Nothing was sent.`);
    return 0;
  }

  const target = values["base-url"] ? await httpTarget(checkLocalBaseUrl(values["base-url"])) : await inProcessTarget();
  const routes = pickRoutes(listArg(values.route), target);
  const clipsSha256 = createHash("sha256").update(readFileSync(CLIPS_PATH)).digest("hex");
  const rawDir = join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const stamp = stampOf(new Date());
  let cards = 0;
  let presses = 0;

  for (const route of routes) {
    const startedAt = new Date().toISOString();
    const records = await runRoute({ route, runs, clips: audio, file, cardLang, mockMode, pressTime, target, stamp });
    const raw: RawRun = {
      kind: "catchup-eval-raw",
      version: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      route,
      mode: target.mode,
      ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
      pressTime,
      runs,
      set,
      clipIds: audio.map((a) => a.clip.id),
      cardLang,
      audio: { dir: rel(audioDir), synthetic: isSyntheticDir(audioDir) },
      models: target.models,
      clipsSha256,
      records,
    };
    const path = join(rawDir, `${stamp}-${route}.json`);
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    console.log(`Saved ${rel(path)}.`);
    presses += records.length;
    cards += records.filter((r) => r.card).length;
  }

  const summaries = writeSummary(outDir, file, set, pressTime);
  for (const s of summaries.filter((x) => routes.includes(x.route))) {
    console.log(`${s.route.padEnd(12)} ${s.cards} cards of ${s.presses} presses, full card p50 ${seconds(s.fullCard.p50)}, p95 ${seconds(s.fullCard.p95)}`);
  }
  return cards === 0 && presses > 0 ? 2 : 0;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(EVAL_DIR, "run.ts");
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof SetupError) console.error(error.message);
      else console.error(error instanceof Error ? (error.stack ?? error.message) : "The eval failed.");
      process.exit(1);
    },
  );
}
