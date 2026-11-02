import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_COMMANDS,
  DESKTOP_HOTKEY_PRESETS,
  DESKTOP_IPC,
  getDesktopBridge,
  isWarmingUp,
  nextWindow,
} from "./audio/types";
import {
  ASK_TO_VALUES,
  CARD_BODY_JSON_SCHEMA,
  CARD_JSON_SCHEMA_NAME,
  CARD_KEY_ORDER,
  Card,
  CardBody,
  FACT_KINDS,
  HEARD_VALUES,
  LIVE_ROUTES,
  LIVE_ROUTE_LABELS,
  META_RESPONSE_FORMAT,
  ROUTE_LABELS,
  SAY_LANGS,
  routeLabelOf,
  routeAModelLabel,
  widthOf,
} from "./card/schema";
import { COPY_BANNED_WORDS, copyRuleProblems } from "./copy-rules";
import { ERROR_CODES, PROVIDER_FAILURES } from "./protocol";
import {
  AUTO_POLICY,
  BASETEN_BODY_FIELDS,
  ENV_DEFAULTS,
  ENV_KEYS,
  META_ASR,
  META_CHAT_BODY_FIELDS,
  ProviderError,
  ROUTE_A,
  ROUTE_B,
  SECRET_ENV_KEYS,
  asrKeywords,
  buildAsrRequest,
  isContributorModel,
  isProviderError,
  type BasetenChatBody,
  type MetaChatBody,
} from "./providers/types";
import { getCachedCard, listSampleClips } from "./samples/catalog";

type JsonNode = { [key: string]: unknown };

const fullCard = {
  heard: "partial",
  ask: { to: "room", text: "Who can take the notes today?" },
  say: { text: "Just to check, notes for today's meeting?", lang: "en" },
  summary: ["Someone asked the room who takes notes."],
  facts: [{ kind: "task", text: "Take notes" }],
  meta: {
    id: "c1",
    pressedAt: "2026-11-02T10:42:40.123-05:00",
    windowSec: 60,
    sentSec: 42.5,
    cardLang: "en",
    source: "mic",
    route: "meta_api",
    model: "muse-voice-transcribe-1.0 + muse-spark-1.3",
    fallbackFrom: "open_weights",
    ms: { total: 6100 },
    bytesSent: 1_360_044,
    sent: { body: "audio", names: true, hint: false },
    transcript: "Who can take the notes today?",
  },
};

describe("card schema", () => {
  it("accepts a full card and strips unknown keys", () => {
    const parsed = Card.parse({ ...fullCard, extra: 1 });
    expect(parsed).not.toHaveProperty("extra");
    expect(parsed.meta.fallbackFrom).toBe("open_weights");
    expect(parsed.meta.sent).toEqual({ body: "audio", names: true, hint: false });
  });

  it("requires a sent record, and the saved run of a cached card", () => {
    const withMeta = (patch: object) => ({ ...fullCard, meta: { ...fullCard.meta, fallbackFrom: undefined, ...patch } });
    const { sent: _sent, ...noSent } = fullCard.meta;
    void _sent;
    expect(Card.safeParse({ ...fullCard, meta: noSent }).success).toBe(false);
    const cached = { route: "cached", model: "meta-models/muse-spark-open-1026", transcript: undefined };
    expect(Card.safeParse(withMeta(cached)).success).toBe(false);
    expect(Card.safeParse(withMeta({ ...cached, cachedFrom: "open_weights" })).success).toBe(false);
    const ok = withMeta({ ...cached, cachedFrom: "open_weights", cachedRunAt: "2026-11-03", cachedBecause: "live_off" });
    expect(Card.safeParse(ok).success).toBe(true);
    expect(Card.safeParse(withMeta({ cachedBecause: "live_off" })).success).toBe(false);
  });

  it("labels cached cards by the live route of their saved run", () => {
    expect(routeLabelOf({ route: "cached", cachedFrom: "open_weights" })).toBe("Saved result from Muse Spark Open");
    expect(routeLabelOf({ route: "cached", cachedFrom: "meta_api" })).toBe(
      "Saved result from Muse Voice Transcribe and Muse Spark",
    );
    expect(routeLabelOf({ route: "open_weights" })).toBe(LIVE_ROUTE_LABELS.open_weights);
    expect(routeLabelOf({ route: "mock" })).toBe(ROUTE_LABELS.mock);
    for (const route of LIVE_ROUTES) {
      expect(copyRuleProblems(routeLabelOf({ route: "cached", cachedFrom: route }))).toEqual([]);
    }
  });

  it("checks structure and enums but not width", () => {
    const ok = (patch: object) => CardBody.safeParse({ ...fullCard, ...patch }).success;
    expect(ok({ summary: ["a".repeat(500), "b"] })).toBe(true);
    expect(ok({ summary: ["a", "b", "c"] })).toBe(false);
    expect(ok({ summary: [] })).toBe(false);
    expect(ok({ facts: Array.from({ length: 6 }, () => ({ kind: "term", text: "x" })) })).toBe(false);
    expect(ok({ facts: [{ kind: "term", text: "x", unsure: false }] })).toBe(false);
    expect(ok({ heard: "loud" })).toBe(false);
    expect(ok({ earlier: true })).toBe(true);
  });

  it("measures width units", () => {
    expect(widthOf("abc")).toBe(3);
    expect(widthOf("日本語")).toBe(6);
    expect(widthOf("中文")).toBe(4);
    expect(widthOf("ｶﾀｶﾅ")).toBe(4); // half-width katakana
    expect(widthOf("ＡＢ")).toBe(4); // full-width Latin
    expect(widthOf("é")).toBe(1);
    expect(widthOf("😀")).toBe(2);
    expect(widthOf("Seika, セイカ, 星佳")).toBe(19);
  });

  it("labels every route in plain English", () => {
    for (const label of Object.values(ROUTE_LABELS)) expect(copyRuleProblems(label), label).toEqual([]);
  });
});

describe("JSON Schema for response_format", () => {
  const schema = CARD_BODY_JSON_SCHEMA as unknown as JsonNode;
  const props = schema.properties as Record<string, JsonNode>;
  const enumOf = (node: JsonNode) => node.enum as string[];
  const itemProps = (props.facts.items as JsonNode).properties as Record<string, JsonNode>;

  it("matches the zod CardBody keys, order and enums", () => {
    expect(Object.keys(props)).toEqual([...CARD_KEY_ORDER]);
    expect(Object.keys(CardBody.shape).sort()).toEqual([...CARD_KEY_ORDER].sort());
    expect(enumOf(props.heard)).toEqual([...HEARD_VALUES]);
    expect(enumOf((props.ask.properties as Record<string, JsonNode>).to)).toEqual([...ASK_TO_VALUES]);
    expect(enumOf((props.say.properties as Record<string, JsonNode>).lang)).toEqual([...SAY_LANGS]);
    expect(enumOf(itemProps.kind)).toEqual([...FACT_KINDS]);
    expect(Object.keys(props.ask.properties as object)).toEqual(["to", "text", "by"]);
    expect(Object.keys(props.say.properties as object)).toEqual(["text", "lang", "gloss"]);
    expect(Object.keys(itemProps)).toEqual(["kind", "text", "note", "unsure"]);
    expect(schema.required).toEqual(["heard", "ask", "summary", "facts"]);
  });

  it("follows Meta Model API structured output rules", () => {
    expect(CARD_JSON_SCHEMA_NAME).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(META_RESPONSE_FORMAT.json_schema.strict).toBe(false);
    let maxDepth = 0;
    let propertyCount = 0;
    let enumCount = 0;
    const walk = (node: unknown, depth: number) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, depth));
      if (!node || typeof node !== "object") return;
      const obj = node as JsonNode;
      for (const banned of ["$ref", "$defs", "allOf", "oneOf", "anyOf", "not"]) expect(obj).not.toHaveProperty(banned);
      if (obj.type === "object") {
        maxDepth = Math.max(maxDepth, depth);
        expect(obj.additionalProperties).toBe(false);
        const keys = Object.keys(obj.properties as object);
        propertyCount += keys.length;
        for (const key of obj.required as string[]) expect(keys).toContain(key);
      }
      if (Array.isArray(obj.enum)) enumCount += obj.enum.length;
      for (const value of Object.values(obj)) walk(value, depth + 1);
    };
    walk(schema, 1);
    expect(maxDepth).toBeLessThanOrEqual(10);
    expect(propertyCount).toBeLessThan(5000);
    expect(enumCount).toBeLessThan(1000);
    expect(JSON.stringify(schema).length).toBeLessThan(120_000);
  });
});

describe("server contract", () => {
  const example = readFileSync(fileURLToPath(new URL("../../.env.example", import.meta.url)), "utf8");
  const entries = new Map(
    example
      .split(/\r?\n/)
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const),
  );

  it("lists every env var once in .env.example, keys empty, nothing public", () => {
    expect([...entries.keys()].sort()).toEqual([...ENV_KEYS].sort());
    for (const key of SECRET_ENV_KEYS) expect(entries.get(key)).toBe("");
    expect(example).not.toMatch(/^NEXT_PUBLIC_/m);
  });

  it("keeps .env.example values equal to the code defaults", () => {
    for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
      const written = entries.get(key);
      if (value === null) expect(written, key).toBe("");
      else if (typeof value === "boolean") expect(written, key).toBe(value ? "1" : "0");
      else if (typeof value === "number") expect(Number(written), key).toBe(value);
      else expect(written, key).toBe(value);
    }
  });

  it("keeps .env.example comments inside the writing rules", () => {
    const comments = example.split(/\r?\n/).filter((line) => line.startsWith("#"));
    for (const line of comments) {
      const text = line.replace(/^#\s*/, "").replace(/\bNEXT_PUBLIC_\b/, "the public prefix");
      expect(copyRuleProblems(text), line).toEqual([]);
    }
  });

  it("never puts model text in a ProviderError message", () => {
    const error = new ProviderError("bad_json", "open_weights", { status: 200, raw: "SECRET CARD TEXT" });
    expect(isProviderError(error)).toBe(true);
    expect(error.message).not.toContain("SECRET");
    expect(String(error)).not.toContain("SECRET");
    expect(error.raw).toBe("SECRET CARD TEXT");
  });

  it("falls back only on provider failures that another route can fix", () => {
    expect([...AUTO_POLICY.order]).toEqual([...LIVE_ROUTES]);
    for (const code of AUTO_POLICY.fallbackOn) expect(PROVIDER_FAILURES).toContain(code);
    for (const code of ["not_configured", "aborted", "bad_input"]) {
      expect(AUTO_POLICY.fallbackOn as readonly string[]).not.toContain(code);
    }
    expect(ERROR_CODES).toContain("aborted");
  });

  it("keeps the public Baseten slug out of the default env", () => {
    expect(ENV_DEFAULTS.BASETEN_MODEL).toBe("meta-models/muse-spark-open-1026");
    expect(ENV_DEFAULTS.BASETEN_MODEL_FALLBACK).toBeNull();
    expect(entries.get("BASETEN_MODEL_FALLBACK")).toBe("");
    expect([...ROUTE_B.slugFallbackStatuses]).toEqual([403, 404]);
  });

  it("never accepts a contributor model", () => {
    expect(isContributorModel("muse-spark-1.3-contributor")).toBe(true);
    expect(isContributorModel(" muse-spark-1.2-CONTRIBUTOR ")).toBe(true);
    expect(isContributorModel(ENV_DEFAULTS.META_CARD_MODEL)).toBe(false);
    expect(isContributorModel(ENV_DEFAULTS.META_ASR_MODEL)).toBe(false);
    expect(isContributorModel(ENV_DEFAULTS.BASETEN_MODEL)).toBe(false);
  });

  it("sends Baseten and Meta only their documented body fields and roles", () => {
    const route: BasetenChatBody = {
      model: ENV_DEFAULTS.BASETEN_MODEL,
      messages: [
        { role: ROUTE_B.instructionRole, content: "rules" },
        {
          role: "user",
          content: [
            { type: "text", text: "press" },
            { type: "audio_url", audio_url: { url: `${ROUTE_B.audioDataUrlPrefix}UklGRg` } },
          ],
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: ROUTE_B.reasoningEffort,
      max_tokens: ENV_DEFAULTS.BASETEN_MAX_TOKENS,
      temperature: ENV_DEFAULTS.BASETEN_TEMPERATURE,
      top_k: -1,
    };
    expect(Object.keys(route).sort()).toEqual([...BASETEN_BODY_FIELDS].sort());
    expect(route.messages[0].role).toBe("system");
    expect(route.reasoning_effort).toBe("low");

    const card: MetaChatBody = {
      model: ENV_DEFAULTS.META_CARD_MODEL,
      messages: [
        { role: ROUTE_A.instructionRole, content: "rules" },
        { role: "user", content: "press and transcript" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: ROUTE_A.reasoningEffort,
      max_completion_tokens: ENV_DEFAULTS.META_MAX_COMPLETION_TOKENS,
      response_format: META_RESPONSE_FORMAT,
    };
    expect(Object.keys(card).sort()).toEqual([...META_CHAT_BODY_FIELDS].sort());
    expect(card.messages[0].role).toBe("developer");
    expect(card.reasoning_effort).toBe("minimal");
  });

  it("builds the Voice Transcribe request from typed constants", () => {
    expect(META_ASR).toMatchObject({ requestPart: "request", audioPart: "audio", audioEncoding: "WAV", mode: "PUSH_TO_TALK" });
    const press = {
      meetingLang: "en",
      cardLang: "ja",
      names: ["Seika", "セイカ", "星佳"],
      hint: "Dr. Rivera, BIO-110、cell membranes，seika",
    } as const;
    expect(buildAsrRequest(press, ENV_DEFAULTS.META_ASR_MODEL)).toEqual({
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "PUSH_TO_TALK",
      languageBias: ["English", "Japanese"],
      keywords: ["Seika", "セイカ", "星佳", "Dr. Rivera", "BIO-110", "cell membranes"],
    });
    const plain = buildAsrRequest({ meetingLang: "zh", cardLang: "zh", names: [] }, "muse-voice-transcribe-1.0");
    expect(plain.languageBias).toEqual(["Mandarin Chinese"]);
    expect(plain).not.toHaveProperty("keywords");
    const many = asrKeywords({ names: [], hint: Array.from({ length: 30 }, (_, i) => `term${i}`).join(", ") });
    expect(many).toHaveLength(META_ASR.maxKeywords);
  });
});

describe("client contract", () => {
  it("steps the window for Further back and gates warm-up", () => {
    expect(nextWindow(30)).toBe(60);
    expect(nextWindow(60)).toBe(120);
    expect(nextWindow(120)).toBeNull();
    expect(isWarmingUp(4.9)).toBe(true);
    expect(isWarmingUp(5)).toBe(false);
  });

  it("uses modifier hotkeys only, Ctrl+Alt+C first", () => {
    expect(DESKTOP_HOTKEY_PRESETS[0]).toBe("Control+Alt+C");
    for (const preset of DESKTOP_HOTKEY_PRESETS) expect(preset).toMatch(/^Control\+(Alt|Shift)\+/);
    const channels = Object.values(DESKTOP_IPC);
    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) expect(channel.startsWith("catchup:")).toBe(true);
    expect(getDesktopBridge()).toBeNull();
  });

  it("sends tray Catch me up as a press on the hotkey channel, not as a command", () => {
    expect([...DESKTOP_COMMANDS]).toEqual(["pause", "resume"]);
    expect(DESKTOP_IPC.hotkey).toBe("catchup:hotkey");
    expect(DESKTOP_IPC.hotkeyChanged).toBe("catchup:hotkey-changed");
  });

  it("starts with no public samples and no cached cards", () => {
    expect(Array.isArray(listSampleClips())).toBe(true);
    expect(getCachedCard("missing", "en")).toBeNull();
  });

  it("keeps the sample catalog browser safe", () => {
    const source = readFileSync(fileURLToPath(new URL("./samples/catalog.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:node:|fs|path|@\/lib\/server|\.\.\/server)/);
    expect(source).not.toMatch(/\brequire\(/);
  });
});

describe("copy rules", () => {
  it("passes clean copy and flags each broken rule", () => {
    expect(copyRuleProblems("Sent 30 s of audio at 10:42:40. Nothing saved.")).toEqual([]);
    expect(copyRuleProblems("Numbers 13–19 and `a:b` and https://example.com/x")).toEqual([]);
    expect(copyRuleProblems("Wait — what")).toContain("em_dash");
    expect(copyRuleProblems("Wait – what")).toContain("en_dash");
    expect(copyRuleProblems("Wait - what")).toContain("hyphen_separator");
    expect(copyRuleProblems("on/off")).toContain("slash");
    expect(copyRuleProblems("one; two")).toContain("semicolon");
    expect(copyRuleProblems("Note: this")).toContain("colon");
    expect(copyRuleProblems("A seamless flow")).toContain("word:seamless");
    expect(copyRuleProblems("well-known long-term real-time")).toEqual([]);
    expect(copyRuleProblems("POST /api/card reads src/lib/protocol.ts and ./eval/run.ts")).toEqual([]);
    expect(copyRuleProblems("Pick tab/window audio")).toContain("slash");
    expect(COPY_BANNED_WORDS).toHaveLength(19);
  });

  it("lets receipts name both routes' model ids", () => {
    const routeB = `Sent the last 30 s of audio, your name and card language to ${LIVE_ROUTE_LABELS.open_weights} (${ENV_DEFAULTS.BASETEN_MODEL}) at 10:42:40. Card in 2.9 s. Catch Up saved nothing.`;
    const routeA = `Sent the last 60 s of audio and card language to ${LIVE_ROUTE_LABELS.meta_api} (${routeAModelLabel(ENV_DEFAULTS.META_ASR_MODEL, ENV_DEFAULTS.META_CARD_MODEL)}) at 10:42:40. Card in 6.1 s. Catch Up saved nothing.`;
    expect(copyRuleProblems(routeB)).toEqual([]);
    expect(copyRuleProblems(routeA)).toEqual([]);
    expect(copyRuleProblems("Dev slug meta-models/muse-spark-open, tab/window")).toEqual(["slash"]);
  });
});
