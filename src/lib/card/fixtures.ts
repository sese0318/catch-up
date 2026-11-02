// Mock card bodies for dev, tests and the mock provider (ux-spec 7 Modes 3). Card lane.
// Never filmed and never in the README. Every body must pass CardBody and the clamp unchanged.
import type { MockFixtureKind } from "../protocol";
import type { CardBody, CardLang } from "./schema";

/**
 * One body per kind (you, room, mentioned, none, poor, no_speech, unsure_number, mixed) in
 * en, ja and zh. Fictional names only.
 */
export function mockCardBody(kind: MockFixtureKind, lang: CardLang): CardBody {
  void kind;
  void lang;
  throw new Error("not implemented");
}
