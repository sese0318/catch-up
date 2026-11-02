// Route B, the primary route (ux-spec 2-4). Baseten Chat Completions, where Muse Spark Open hears the
// WAV directly as an audio_url data URL. Server only. Plain fetch, no SDK, because Baseten's request
// schema is closed and the OpenAI types know neither audio_url nor top_k.
import { parseCardText, type ClampContext } from "../card/parse";
import { promptInputFromMeta, systemPrompt, userText } from "../card/prompt";
import { answerFailure, readChatCompletion } from "./sse";
import {
  defaultFetch,
  fetchUpstream,
  discardBody,
  joinUrl,
  onlyFields,
  statusError,
  toBase64,
  type ProviderOptions,
} from "./shared";
import {
  BASETEN_BODY_FIELDS,
  ProviderError,
  ROUTE_B,
  isContributorModel,
  type BasetenChatBody,
  type BasetenUserPart,
  type CardProvider,
  type ServerEnv,
} from "./types";

export type AudioPartShape = "audio_url" | "input_audio";

/** Dev only. Slugs that answered 403 or 404, remembered for the life of this server instance. */
const missedSlugs = new Set<string>();

export function forgetMissedSlugs(): void {
  missedSlugs.clear();
}

const slugKey = (baseUrl: string, slug: string) => `${baseUrl} ${slug}`;

/**
 * The slugs to try, in order. BASETEN_MODEL first. The dev fallback slug (always null in production)
 * is tried once after a 403 or 404, and once the main slug missed, later presses go straight to it.
 */
export function basetenSlugPlan(cfg: ServerEnv["baseten"]): string[] {
  const fallback = cfg.modelFallback;
  if (!fallback || fallback === cfg.model || isContributorModel(fallback)) return [cfg.model];
  return missedSlugs.has(slugKey(cfg.baseUrl, cfg.model)) ? [fallback] : [cfg.model, fallback];
}

/** The whole Route B body. temperature and top_k are left out when env holds null for them. */
export function buildBasetenBody(
  cfg: ServerEnv["baseten"],
  slug: string,
  instructions: string,
  pressText: string,
  wavBase64: string,
  shape: AudioPartShape,
): BasetenChatBody {
  const audio: BasetenUserPart =
    shape === "audio_url"
      ? { type: "audio_url", audio_url: { url: `${ROUTE_B.audioDataUrlPrefix}${wavBase64}` } }
      : { type: "input_audio", input_audio: { data: wavBase64, format: "wav" } };
  const body: BasetenChatBody = {
    model: slug,
    messages: [
      { role: ROUTE_B.instructionRole, content: instructions },
      { role: "user", content: [{ type: "text", text: pressText }, audio] },
    ],
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: ROUTE_B.reasoningEffort,
    max_tokens: cfg.maxTokens,
  };
  if (cfg.temperature !== null) body.temperature = cfg.temperature;
  if (cfg.topK !== null) body.top_k = cfg.topK;
  return body;
}

export function createOpenWeightsProvider(env: ServerEnv, options: ProviderOptions = {}): CardProvider {
  const cfg = env.baseten;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const now = options.now ?? Date.now;
  const configured = () => Boolean(cfg.apiKey) && Boolean(cfg.model) && !isContributorModel(cfg.model);

  return {
    id: "open_weights",
    isConfigured: configured,
    modelLabel: () => cfg.model,

    async run({ wav, meta, signal, onStage }) {
      const started = now();
      if (!configured()) throw new ProviderError("not_configured", "open_weights");
      if (!wav) throw new ProviderError("bad_input", "open_weights");

      const ctx: ClampContext = { cardLang: meta.cardLang, meetingLang: meta.meetingLang };
      const instructions = systemPrompt();
      const pressText = userText(promptInputFromMeta(meta, null));
      const wavBase64 = toBase64(wav);
      const headers = {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        [ROUTE_B.affinityHeader]: meta.sessionId,
      };
      const post = (slug: string, shape: AudioPartShape) =>
        fetchUpstream(fetchImpl, "open_weights", joinUrl(cfg.baseUrl, ROUTE_B.path), {
          method: "POST",
          headers,
          body: JSON.stringify(
            onlyFields(buildBasetenBody(cfg, slug, instructions, pressText, wavBase64, shape), BASETEN_BODY_FIELDS),
          ),
          signal,
        });

      const slugs = basetenSlugPlan(cfg);
      let slug = slugs[0];
      let res: Response | null = null;
      for (let i = 0; i < slugs.length; i++) {
        slug = slugs[i];
        res = await post(slug, "audio_url");
        if (res.status === ROUTE_B.inputAudioRetryStatus) {
          // Baseten's generic schema lists input_audio, the Muse audio guide lists audio_url. One retry.
          await discardBody(res);
          res = await post(slug, "input_audio");
        }
        const missed = (ROUTE_B.slugFallbackStatuses as readonly number[]).includes(res.status);
        if (missed && i + 1 < slugs.length) {
          missedSlugs.add(slugKey(cfg.baseUrl, slug));
          await discardBody(res);
          continue;
        }
        break;
      }
      if (!res) throw new ProviderError("not_configured", "open_weights");
      if (!res.ok) throw await statusError("open_weights", res, now(), { model: slug });

      let firstTokenMs: number | undefined;
      const outcome = await readChatCompletion(res, {
        provider: "open_weights",
        signal,
        onFirstContent: () => {
          firstTokenMs = now() - started;
          onStage({ name: "writing", atMs: firstTokenMs });
        },
      });
      const raw = outcome.content || undefined;
      const failure = answerFailure(outcome, true);
      if (failure) throw new ProviderError(failure, "open_weights", { status: res.status, raw, model: slug });

      const parsed = parseCardText(outcome.content, ctx);
      if (!parsed.ok) throw new ProviderError("bad_json", "open_weights", { status: res.status, raw, model: slug });
      return {
        body: parsed.body,
        model: slug,
        parse: parsed.quality,
        timings: { totalMs: now() - started, firstTokenMs },
        usage: outcome.usage,
      };
    },
  };
}
