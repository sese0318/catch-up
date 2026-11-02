// Request handlers behind src/app/api/card/route.ts and src/app/api/health/route.ts. Server lane.
// Plain Web Request and Response, so vitest and the eval runner can call them without Next.
import { unformattedBody, type ClampContext } from "../card/parse";
import { CardBody, type LiveRoute } from "../card/schema";
import {
  LIMITS,
  META_HEADER,
  PROTOCOL_VERSION,
  SSE_HEADERS,
  TokenUsage,
  WireCard,
  bodyKindOf,
  checkClipWav,
  decodeMetaHeader,
  encodeEventBytes,
  errorCodeFromFailure,
  errorData,
  errorEventResponse,
  type ErrorCode,
  type ErrorData,
  type HealthResponse,
  type PressMeta,
  type ProviderFailure,
  type ServerCardMeta,
  type StreamEvent,
} from "../protocol";
import { createProviders, isMockProvider, planRoutes } from "../providers";
import {
  AUTO_POLICY,
  LOCAL_CLIENT_KEY,
  PROVIDER_IDS,
  ProviderError,
  isProviderError,
  type CardHandlerDeps,
  type CardProvider,
  type HealthHandlerDeps,
  type PressLogEntry,
  type ProviderId,
  type ProviderResult,
  type ServerEnv,
} from "../providers/types";
import { readBodyCapped } from "./body";
import { readServerEnv } from "./env";
import { pressGuards } from "./guards";
import { logPress } from "./log";

// Why a press stopped early. The handler knows the reason, so providers only report aborted.
const CLIENT_GONE = Symbol("client_gone");
const DEADLINE = Symbol("deadline");
const NO_TOKEN = Symbol("no_token");

/** The one JSON retry of a lone Route B runs only with this much time left before the deadline. */
const RETRY_MIN_LEFT_MS = 8_000;

/** A provider failure, or a bug in a provider (internal), which Auto also answers with the backup route. */
type Failure = ProviderFailure | "internal";

type Logger = (entry: PressLogEntry) => void;

interface PressJob {
  meta: PressMeta;
  env: ServerEnv;
  routes: ProviderId[];
  pinned: boolean;
  providers: Record<ProviderId, CardProvider>;
  wav: Uint8Array | null;
  transcript: string | null;
  bytes: number;
  arrivedAt: number;
  now: () => number;
  log: Logger;
  requestSignal: AbortSignal;
}

type Attempt =
  | { ok: true; result: ProviderResult }
  | { ok: false; failure: Failure; error?: ProviderError };

function providersFor(
  env: ServerEnv,
  overrides: Partial<Record<ProviderId, CardProvider>> | undefined,
): Record<ProviderId, CardProvider> {
  const providers = createProviders(env);
  for (const id of PROVIDER_IDS) {
    const provider = overrides?.[id];
    if (provider) providers[id] = provider;
  }
  return providers;
}

function safeLogger(log: Logger): Logger {
  return (entry) => {
    try {
      log(entry);
    } catch {
      // logging never breaks a press
    }
  };
}

/** The rate limit key. deps.clientKey, else the first x-forwarded-for address, else LOCAL_CLIENT_KEY. */
function clientKeyOf(req: Request, custom: CardHandlerDeps["clientKey"]): string {
  if (custom) {
    try {
      const key = custom(req);
      if (key) return key;
    } catch {
      // fall through to the header
    }
  }
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || LOCAL_CLIENT_KEY;
}

function decodeTranscript(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

const isLiveRoute = (id: ProviderId | null): id is LiveRoute => id === "open_weights" || id === "meta_api";

function failureOf(error: unknown, reason: unknown): Failure {
  if (reason === NO_TOKEN) return "no_token";
  if (reason === DEADLINE) return "timeout";
  if (reason === CLIENT_GONE) return "aborted";
  return isProviderError(error) ? error.code : "internal";
}

function canFallBack(failure: Failure): boolean {
  return failure === "internal" || (AUTO_POLICY.fallbackOn as readonly string[]).includes(failure);
}

function errorCodeOf(failure: Failure | null, stopReason: unknown): ErrorCode {
  if (failure === null) return stopReason === DEADLINE ? "timeout" : "server_error";
  if (failure === "internal") return "server_error";
  const code = errorCodeFromFailure(failure);
  return code === "aborted" ? "provider_error" : code; // aborted is a client-only code
}

function cleanUsage(usage: ProviderResult["usage"]): TokenUsage | undefined {
  const parsed = TokenUsage.safeParse(usage ?? {});
  if (!parsed.success) return undefined;
  const entries = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as TokenUsage) : undefined;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs one provider. The attempt ends when the provider settles or when its signal fires (the client
 * left, the deadline, or the Auto no-token watchdog), whichever comes first, so a provider that
 * ignores its signal can never hold the press past the deadline.
 */
async function runAttempt(
  provider: CardProvider,
  job: PressJob,
  stop: AbortSignal,
  noTokenMs: number | null,
  onWriting: () => void,
): Promise<Attempt> {
  const ctl = new AbortController();
  const forward = () => ctl.abort(stop.reason);
  if (stop.aborted) forward();
  else stop.addEventListener("abort", forward, { once: true });
  let wrote = false;
  const watchdog =
    noTokenMs === null
      ? undefined
      : setTimeout(() => {
          if (!wrote) ctl.abort(NO_TOKEN);
        }, noTokenMs);
  const stopped = new Promise<never>((_, reject) => {
    const fail = () => reject(ctl.signal.reason);
    if (ctl.signal.aborted) fail();
    else ctl.signal.addEventListener("abort", fail, { once: true });
  });
  stopped.catch(() => undefined);

  try {
    const run = provider.run({
      wav: job.wav,
      transcript: job.transcript,
      meta: job.meta,
      signal: ctl.signal,
      onStage: () => {
        if (wrote || ctl.signal.aborted) return;
        wrote = true;
        clearTimeout(watchdog);
        onWriting();
      },
    });
    run.catch(() => undefined); // a provider left behind by the race settles unobserved
    const result = await Promise.race([run, stopped]);
    const body = CardBody.safeParse(result.body);
    if (!body.success) {
      const error = new ProviderError("bad_json", provider.id, { model: result.model, transcript: result.transcript });
      return { ok: false, failure: "bad_json", error };
    }
    return { ok: true, result: { ...result, body: body.data } };
  } catch (error) {
    const reason = ctl.signal.aborted ? ctl.signal.reason : undefined;
    return { ok: false, failure: failureOf(error, reason), error: isProviderError(error) ? error : undefined };
  } finally {
    clearTimeout(watchdog);
    stop.removeEventListener("abort", forward);
  }
}

/** Runs the route plan and writes stage, card or error, and done. Never throws. */
async function runPress(
  job: PressJob,
  send: (event: StreamEvent) => void,
  stop: AbortController,
  clientGone: () => boolean,
): Promise<void> {
  const { meta, providers, now, arrivedAt } = job;
  const elapsed = () => Math.max(0, now() - arrivedAt);
  const ctx: ClampContext = { cardLang: meta.cardLang, meetingLang: meta.meetingLang };
  const deadline = setTimeout(() => stop.abort(DEADLINE), Math.max(0, AUTO_POLICY.serverDeadlineMs - elapsed()));

  let lastRoute: ProviderId | null = null;
  let lastFailure: Failure | null = null;
  let lastError: ProviderError | undefined;
  let fallbackAtMs: number | undefined;
  let fallbackCause: ProviderFailure | undefined;

  const log = (entry: Omit<PressLogEntry, "at" | "windowSec" | "sentSec" | "bytes" | "fallback">) =>
    job.log({
      at: new Date(now()).toISOString(),
      fallback: fallbackAtMs !== undefined,
      windowSec: meta.windowSec,
      sentSec: meta.sentSec,
      bytes: job.bytes,
      ...entry,
    });

  const sendCard = (body: CardBody, server: Omit<ServerCardMeta, "timing">, firstTokenMs?: number, asrMs?: number) => {
    const timing = { totalMs: elapsed(), firstTokenMs, asrMs, fallbackAtMs, bytes: job.bytes };
    const card = WireCard.safeParse({ ...body, meta: { ...server, timing } });
    if (!card.success) return false;
    send({ event: "card", data: card.data });
    send({ event: "done", data: {} });
    return true;
  };

  const sendError = (code: ErrorCode, cause?: ProviderFailure) => {
    const retryAfterSec = lastError?.retryAfterSec;
    const extra: Partial<Pick<ErrorData, "route" | "cause" | "retryAfterSec">> = {};
    if (isLiveRoute(lastRoute)) extra.route = lastRoute;
    if (cause) extra.cause = cause;
    if (retryAfterSec !== undefined && Number.isInteger(retryAfterSec) && retryAfterSec > 0) extra.retryAfterSec = retryAfterSec;
    send({ event: "error", data: errorData(code, extra) });
    send({ event: "done", data: {} });
    log({ status: "error", route: lastRoute, model: lastError?.model ?? null, cause, code, ms: { total: elapsed() } });
  };

  try {
    const first = providers[job.routes[0]];
    if (isMockProvider(first)) await pause(first.receivedDelayMs(meta), stop.signal);
    if (!stop.signal.aborted) send({ event: "stage", data: { name: "received", ms: elapsed() } });

    let served: { route: ProviderId; result: ProviderResult; firstTokenMs?: number } | null = null;
    let rawFrom: { route: ProviderId; error: ProviderError } | null = null;
    let transcript: string | undefined;
    let retried = false;
    const queue = [...job.routes];

    while (queue.length > 0 && !stop.signal.aborted) {
      const id = queue.shift() as ProviderId;
      if (lastRoute !== null && id !== lastRoute) {
        fallbackAtMs = elapsed();
        fallbackCause = lastFailure === null || lastFailure === "internal" ? undefined : lastFailure;
        send({ event: "stage", data: { name: "fallback", ms: fallbackAtMs } });
      }
      let firstTokenMs: number | undefined;
      const watchdogMs = !job.pinned && queue.length > 0 ? job.env.autoFallbackMs : null;
      const attempt = await runAttempt(providers[id], job, stop.signal, watchdogMs, () => {
        firstTokenMs = elapsed();
        send({ event: "stage", data: { name: "writing", ms: firstTokenMs } });
      });
      if (attempt.ok) {
        served = { route: id, result: attempt.result, firstTokenMs };
        break;
      }
      lastRoute = id;
      lastFailure = attempt.failure;
      lastError = attempt.error;
      if (attempt.error?.raw?.trim()) rawFrom = { route: id, error: attempt.error };
      if (attempt.error?.transcript) transcript = attempt.error.transcript;
      if (stop.signal.aborted) break;
      if (queue.length > 0) {
        if (canFallBack(attempt.failure)) continue;
        break;
      }
      const retryJson =
        attempt.failure === "bad_json" &&
        id === "open_weights" &&
        job.routes.length === 1 &&
        !retried &&
        elapsed() < AUTO_POLICY.serverDeadlineMs - RETRY_MIN_LEFT_MS;
      if (retryJson) {
        retried = true;
        queue.push(id);
      }
    }

    if (clientGone()) {
      log({ status: "error", route: lastRoute, model: null, code: "aborted", cause: "aborted", ms: { total: elapsed() } });
      return;
    }

    const fallbackFrom =
      fallbackAtMs !== undefined && job.routes[0] === "open_weights" ? ("open_weights" as const) : undefined;

    if (served) {
      const { route, result } = served;
      const sent = sendCard(
        result.body,
        {
          route,
          model: result.model,
          fallbackFrom: route === "open_weights" ? undefined : fallbackFrom,
          fallbackCause: route === "open_weights" ? undefined : fallbackCause,
          transcript: result.transcript,
          parse: result.parse,
          usage: cleanUsage(result.usage),
        },
        served.firstTokenMs,
        result.timings.asrMs,
      );
      if (!sent) return sendError("server_error");
      log({
        status: "ok",
        route,
        model: result.model,
        cause: fallbackCause,
        parse: result.parse,
        ms: { total: elapsed(), firstToken: served.firstTokenMs, asr: result.timings.asrMs },
      });
      return;
    }

    const cause = lastFailure === null || lastFailure === "internal" ? undefined : lastFailure;
    if (rawFrom) {
      // A card is never blank. When every route failed but some model text exists, show it as is.
      const { route, error } = rawFrom;
      const model = error.model ?? providers[route].modelLabel();
      const sent = sendCard(unformattedBody(error.raw ?? "", ctx), {
        route,
        model,
        fallbackFrom: route === "open_weights" ? undefined : fallbackFrom,
        fallbackCause: route === "open_weights" ? undefined : fallbackCause,
        transcript: error.transcript ?? transcript,
        unformatted: true,
        parse: "unformatted",
      });
      if (!sent) return sendError("server_error");
      log({ status: "ok", route, model, cause, parse: "unformatted", ms: { total: elapsed() } });
      return;
    }

    sendError(errorCodeOf(lastFailure, stop.signal.reason), cause);
  } catch {
    if (!clientGone()) sendError("server_error");
  } finally {
    clearTimeout(deadline);
  }
}

function pressStream(job: PressJob): ReadableStream<Uint8Array> {
  const stop = new AbortController();
  let gone = false;
  let closed = false;
  const leave = () => {
    gone = true;
    stop.abort(CLIENT_GONE);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: StreamEvent) => {
        if (closed || gone) return;
        try {
          controller.enqueue(encodeEventBytes(event));
        } catch {
          closed = true;
        }
      };
      if (job.requestSignal.aborted) leave();
      else job.requestSignal.addEventListener("abort", leave, { once: true });
      void runPress(job, send, stop, () => gone)
        .catch(() => undefined) // runPress already reports its own failures as events
        .finally(() => {
          job.requestSignal.removeEventListener("abort", leave);
          job.wav?.fill(0); // the clip lived only for this request
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // the reader already cancelled
          }
        });
    },
    cancel() {
      closed = true;
      leave();
    },
  });
}

/**
 * POST /api/card. Decodes X-CatchUp-Meta, plans routes, applies the per-client hourly limit and the
 * daily cap (live presses only, mock presses never count), checks the body (checkClipWav or a
 * transcript), then streams stage, card or error, and done. A press counts toward the guards only
 * once its body passes and a live provider is about to run. Errors found before streaming use
 * errorEventResponse. Logs one PressLogEntry per press.
 */
export async function handleCardRequest(req: Request, deps?: CardHandlerDeps): Promise<Response> {
  const now = deps?.now ?? Date.now;
  const arrivedAt = now();
  const log = safeLogger(deps?.log ?? logPress);
  let meta: PressMeta | null = null;
  let route: ProviderId | null = null;
  let bytes = 0;

  const refuse = (code: ErrorCode, extra: Pick<ErrorData, "retryAfterSec"> = {}): Response => {
    log({
      at: new Date(now()).toISOString(),
      status: "error",
      route,
      model: null,
      fallback: false,
      code,
      windowSec: meta?.windowSec,
      sentSec: meta?.sentSec,
      bytes,
      ms: { total: Math.max(0, now() - arrivedAt) },
    });
    return errorEventResponse(code, extra);
  };

  try {
    const env = deps?.env ?? readServerEnv();
    const decoded = decodeMetaHeader(req.headers.get(META_HEADER));
    if (!decoded.ok) return refuse("bad_request");
    meta = decoded.meta;

    // Guards run before the body is read. Mock presses skip them and never count.
    const providers = providersFor(env, deps?.providers);
    const plan = planRoutes(meta.route, env, providers);
    if (!plan.ok) return refuse(plan.code);
    route = plan.routes[0];
    const live = route !== "mock";
    const clientKey = clientKeyOf(req, deps?.clientKey);
    if (live) {
      const hourly = pressGuards.checkHourly(clientKey, arrivedAt, env.ratePerHour);
      if (!hourly.ok) return refuse("rate_limited", { retryAfterSec: hourly.retryAfterSec });
      if (pressGuards.dailyCapReached(arrivedAt, env.dailyCap)) return refuse("daily_cap");
    }

    const kind = bodyKindOf(req.headers.get("content-type"));
    if (kind === null || (kind === "transcript" && meta.route !== "meta_api")) return refuse("bad_request");
    const read = await readBodyCapped(req, kind === "wav" ? LIMITS.maxBodyBytes : LIMITS.maxTranscriptBytes);
    if (!read.ok) return refuse(read.reason === "too_large" ? "too_large" : "bad_request");
    bytes = read.bytes.byteLength;

    let wav: Uint8Array | null = null;
    let transcript: string | null = null;
    if (kind === "wav") {
      const clip = checkClipWav(read.bytes);
      if (!clip.ok) {
        read.bytes.fill(0);
        return refuse(clip.code);
      }
      wav = read.bytes;
    } else {
      transcript = decodeTranscript(read.bytes);
      read.bytes.fill(0);
      if (transcript === null) return refuse("bad_request");
    }

    if (live) pressGuards.count(clientKey, arrivedAt, env.ratePerHour);
    const stream = pressStream({
      meta,
      env,
      routes: plan.routes,
      pinned: plan.pinned,
      providers,
      wav,
      transcript,
      bytes,
      arrivedAt,
      now,
      log,
      requestSignal: req.signal,
    });
    return new Response(stream, { status: 200, headers: { ...SSE_HEADERS } });
  } catch {
    return refuse("server_error");
  }
}

const HEALTH_PROVIDER_NAMES: Readonly<Record<LiveRoute, string>> = {
  open_weights: "Baseten",
  meta_api: "Meta Model API",
};

/** GET /api/health as a HealthResponse. Never includes keys. */
export function handleHealthRequest(deps?: HealthHandlerDeps): Response {
  const env = deps?.env ?? readServerEnv();
  const providers = providersFor(env, deps?.providers);
  const capped = pressGuards.dailyCapReached(Date.now(), env.dailyCap);
  const routeInfo = (id: LiveRoute) => ({
    configured: providers[id].isConfigured(),
    model: providers[id].modelLabel(),
    provider: HEALTH_PROVIDER_NAMES[id],
  });
  const body: HealthResponse = {
    ok: true,
    v: PROTOCOL_VERSION,
    live: env.liveEnabled && !capped,
    paused: !env.liveEnabled ? "live_off" : capped ? "daily_cap" : null,
    defaultRoute: env.routePolicy,
    mock: env.allowMock,
    routes: { open_weights: routeInfo("open_weights"), meta_api: routeInfo("meta_api") },
    limits: {
      maxBodyBytes: LIMITS.maxBodyBytes,
      maxClipSec: LIMITS.maxClipSec,
      perHour: env.ratePerHour,
      hardCapMs: LIMITS.hardCapMs,
    },
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
