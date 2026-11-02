// Route A, the backup route (ux-spec 2-4). Muse Voice Transcribe on the WAV in PUSH_TO_TALK, then
// muse-spark-1.3 writes the card from the transcript text with constrained JSON. Audio never goes to
// muse-spark-1.3 and no -contributor model is ever called. Server only. Plain fetch, no SDK.
import { parseCardText, type ClampContext } from "../card/parse";
import { promptInputFromMeta, systemPrompt, userText } from "../card/prompt";
import { META_RESPONSE_FORMAT, routeAModelLabel } from "../card/schema";
import { WAV_CONTENT_TYPE, type PressMeta, type TokenUsage } from "../protocol";
import { answerFailure, readChatCompletion } from "./sse";
import {
  compactUsage,
  defaultFetch,
  discardBody,
  fetchUpstream,
  isRecord,
  joinUrl,
  onlyFields,
  statusError,
  type FetchLike,
  type ProviderOptions,
} from "./shared";
import {
  META_ASR,
  META_CHAT_BODY_FIELDS,
  ProviderError,
  ROUTE_A,
  buildAsrRequest,
  isContributorModel,
  type CardProvider,
  type MetaAsrRequest,
  type MetaChatBody,
  type ServerEnv,
} from "./types";

/**
 * How the multipart request part travels. json matches Meta's curl example (Content-Type
 * application/json and no filename), which Node's FormData cannot send because a Blob part always
 * gets filename="blob". text is a plain form field. Meta's notes flag the part form as untested
 * without a key (meta-model-api.md 4.2), so a 400 or 415 on the first form retries once with the
 * second. Gate 1 confirms which one Meta takes.
 */
export const ASR_REQUEST_PART_FORMS = ["json", "text"] as const;
export type AsrRequestPartForm = (typeof ASR_REQUEST_PART_FORMS)[number];
const ASR_RETRY_STATUSES = [400, 415];

const encoder = new TextEncoder();

/** A multipart/form-data body with the request part, then the WAV as the audio part (clip.wav). */
export function buildAsrMultipart(
  request: MetaAsrRequest,
  wav: Uint8Array,
  form: AsrRequestPartForm,
  boundary = `CatchUpBoundary${crypto.randomUUID().replace(/-/g, "")}`,
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const requestHead =
    form === "json"
      ? `Content-Disposition: form-data; name="${META_ASR.requestPart}"\r\nContent-Type: application/json`
      : `Content-Disposition: form-data; name="${META_ASR.requestPart}"`;
  const head = encoder.encode(
    `--${boundary}\r\n${requestHead}\r\n\r\n${JSON.stringify(request)}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="${META_ASR.audioPart}"; filename="${META_ASR.audioFileName}"\r\n` +
      `Content-Type: ${WAV_CONTENT_TYPE}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + wav.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(wav, head.byteLength);
  body.set(tail, head.byteLength + wav.byteLength);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** The whole Route A card body. The user message is userText() with the transcript, never audio. */
export function buildMetaChatBody(
  cfg: ServerEnv["meta"],
  instructions: string,
  pressText: string,
): MetaChatBody {
  return {
    model: cfg.cardModel,
    messages: [
      { role: ROUTE_A.instructionRole, content: instructions },
      { role: "user", content: pressText },
    ],
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: ROUTE_A.reasoningEffort,
    max_completion_tokens: cfg.maxCompletionTokens,
    response_format: META_RESPONSE_FORMAT,
  };
}

interface Transcription {
  transcript: string;
  audioSeconds?: number;
}

async function transcribe(
  cfg: ServerEnv["meta"],
  meta: PressMeta,
  wav: Uint8Array,
  signal: AbortSignal,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<Transcription> {
  const request = buildAsrRequest(meta, cfg.asrModel);
  for (let i = 0; i < ASR_REQUEST_PART_FORMS.length; i++) {
    const { body, contentType } = buildAsrMultipart(request, wav, ASR_REQUEST_PART_FORMS[i]);
    const res = await fetchUpstream(fetchImpl, "meta_api", joinUrl(cfg.baseUrl, META_ASR.path), {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: META_ASR.accept, "Content-Type": contentType },
      body,
      signal,
    });
    if (ASR_RETRY_STATUSES.includes(res.status) && i + 1 < ASR_REQUEST_PART_FORMS.length) {
      await discardBody(res);
      continue;
    }
    if (!res.ok) throw await statusError("meta_api", res, now(), { model: cfg.asrModel });

    let json: unknown;
    try {
      json = await res.json();
    } catch (error) {
      throw new ProviderError(signal.aborted ? "aborted" : "http", "meta_api", { status: res.status, cause: error });
    }
    if (!isRecord(json) || typeof json.transcript !== "string") {
      throw new ProviderError("empty", "meta_api", { status: res.status, model: cfg.asrModel });
    }
    const durationMs = json.audioDurationMs;
    return {
      transcript: json.transcript.trim(),
      audioSeconds: typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs / 1000 : undefined,
    };
  }
  throw new ProviderError("http", "meta_api", { model: cfg.asrModel });
}

export function createMetaApiProvider(env: ServerEnv, options: ProviderOptions = {}): CardProvider {
  const cfg = env.meta;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const now = options.now ?? Date.now;
  const usable = (id: string) => Boolean(id) && !isContributorModel(id);
  const configured = () => Boolean(cfg.apiKey) && usable(cfg.cardModel) && usable(cfg.asrModel);

  return {
    id: "meta_api",
    isConfigured: configured,
    modelLabel: () => routeAModelLabel(cfg.asrModel, cfg.cardModel),

    async run({ wav, transcript: earlier, meta, signal, onStage }) {
      const started = now();
      if (!configured()) throw new ProviderError("not_configured", "meta_api");

      let transcript: string;
      let model: string;
      let asrMs: number | undefined;
      let audioSeconds: number | undefined;
      if (earlier !== null) {
        transcript = earlier; // a language redo, transcription is skipped
        model = cfg.cardModel;
      } else if (wav) {
        const asrStarted = now();
        const heard = await transcribe(cfg, meta, wav, signal, fetchImpl, now);
        asrMs = now() - asrStarted;
        transcript = heard.transcript;
        audioSeconds = heard.audioSeconds;
        model = routeAModelLabel(cfg.asrModel, cfg.cardModel);
      } else {
        throw new ProviderError("bad_input", "meta_api");
      }

      const ctx: ClampContext = { cardLang: meta.cardLang, meetingLang: meta.meetingLang };
      const body = buildMetaChatBody(cfg, systemPrompt(), userText(promptInputFromMeta(meta, transcript)));
      const res = await fetchUpstream(fetchImpl, "meta_api", joinUrl(cfg.baseUrl, ROUTE_A.chatPath), {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(onlyFields(body, META_CHAT_BODY_FIELDS)),
        signal,
      });
      if (!res.ok) throw await statusError("meta_api", res, now(), { model, transcript });

      let firstTokenMs: number | undefined;
      const outcome = await readChatCompletion(res, {
        provider: "meta_api",
        signal,
        onFirstContent: () => {
          firstTokenMs = now() - started;
          onStage({ name: "writing", atMs: firstTokenMs });
        },
      });
      const raw = outcome.content || undefined;
      // Meta documents finish_reason on the final chunk but not data: [DONE], so a clean end is enough here.
      const failure = answerFailure(outcome, false);
      if (failure) throw new ProviderError(failure, "meta_api", { status: res.status, raw, transcript, model });

      const parsed = parseCardText(outcome.content, ctx);
      if (!parsed.ok) throw new ProviderError("bad_json", "meta_api", { status: res.status, raw, transcript, model });
      const usage: TokenUsage = { ...outcome.usage, audioSeconds };
      return {
        body: parsed.body,
        model,
        parse: parsed.quality,
        transcript,
        timings: { totalMs: now() - started, firstTokenMs, asrMs },
        usage: compactUsage(usage),
      };
    },
  };
}
