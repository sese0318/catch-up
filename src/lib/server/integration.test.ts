// The server lane with the real card lane (prompt, parse and fixtures), and only the upstream faked.
// Assertions stay structural, so wording changes in the card lane do not break them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemPrompt } from "../card/prompt";
import { CARD_LANGS } from "../card/schema";
import { MOCK_FIXTURE_KINDS, WireCard, type StreamEvent } from "../protocol";
import { createMockProvider } from "../providers";
import { forgetMissedSlugs } from "../providers/open-weights";
import { pressGuards } from "./guards";
import { handleCardRequest } from "./handle-card";
import {
  cardRequest,
  chatStream,
  eventsOf,
  fakeFetch,
  jsonBodyOf,
  namesOf,
  sampleCardJson,
  testEnv,
  testMeta,
} from "./test-support";

const quiet = { log: () => undefined };

function cardOf(events: StreamEvent[]): WireCard {
  const card = events.find((e) => e.event === "card");
  if (!card || card.event !== "card") throw new Error(`no card in ${namesOf(events).join(", ")}`);
  return card.data;
}

beforeEach(() => {
  pressGuards.reset();
  forgetMissedSlugs();
});

afterEach(() => vi.unstubAllGlobals());

describe("server lane with the real card lane", () => {
  it("sends the real system prompt and press text to Route B and parses a fenced answer", async () => {
    const { fetchImpl, calls } = fakeFetch(chatStream({ content: ["```json\n", sampleCardJson, "\n```"] }));
    vi.stubGlobal("fetch", fetchImpl);
    const events = await eventsOf(await handleCardRequest(cardRequest(), { env: testEnv(), ...quiet }));
    expect(namesOf(events)).toEqual(["stage:received", "stage:writing", "card", "done"]);

    const messages = jsonBodyOf(calls[0]).messages as { role: string; content: unknown }[];
    expect(messages[0]).toEqual({ role: "system", content: systemPrompt() });
    const parts = messages[1].content as { type: string; text?: string }[];
    expect(parts.map((p) => p.type)).toEqual(["text", "audio_url"]);
    expect(parts[0].text?.length).toBeGreaterThan(0);

    const card = cardOf(events);
    expect(WireCard.safeParse(card).success).toBe(true);
    expect(card.ask.to).toBe("you");
    expect(["clean", "clamped"]).toContain(card.meta.parse);
  });

  it("serves every real mock fixture in every card language", async () => {
    const env = testEnv({ allowMock: true });
    const deps = { env, providers: { mock: createMockProvider(env, { timeScale: 0 }) }, ...quiet };
    for (const fixture of MOCK_FIXTURE_KINDS) {
      for (const cardLang of CARD_LANGS) {
        const meta = testMeta({ route: "mock", cardLang, mock: { mode: "ok", fixture } });
        const card = cardOf(await eventsOf(await handleCardRequest(cardRequest({ meta }), deps)));
        expect(card.meta.route, `${fixture} ${cardLang}`).toBe("mock");
        expect(card.summary[0].length, `${fixture} ${cardLang}`).toBeGreaterThan(0);
      }
    }
  });

  it("ends a lone Route B that never returns JSON in an Unformatted card from the card lane", async () => {
    const prose = "Sorry, I could not format this. Someone asked about Thursday.";
    const { fetchImpl, calls } = fakeFetch(chatStream({ content: [prose] }), chatStream({ content: [prose] }));
    vi.stubGlobal("fetch", fetchImpl);
    const env = testEnv({ meta: { apiKey: null } });
    const card = cardOf(await eventsOf(await handleCardRequest(cardRequest(), { env, ...quiet })));
    expect(calls).toHaveLength(2); // the one JSON retry of a lone Route B
    expect(card.meta).toMatchObject({ route: "open_weights", unformatted: true, parse: "unformatted" });
    expect(card.summary[0]).toContain("Thursday");
  });
});
