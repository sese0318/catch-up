// Width-capped fields of a card body. Card lane. Used by tests and the eval to check caps.
import { CAPS, widthOf, type CardBody } from "./schema";

export interface CappedField {
  path: string; // for example facts[2].note
  text: string;
  cap: number;
}

/** Every width-capped string in a body with its cap, in card order. */
export function cappedFields(body: CardBody): CappedField[] {
  const out: CappedField[] = [];
  const add = (path: string, text: string | undefined, cap: number) => {
    if (text !== undefined) out.push({ path, text, cap });
  };
  add("ask.text", body.ask.text, CAPS.askText);
  add("ask.by", body.ask.by, CAPS.askBy);
  add("say.text", body.say?.text, CAPS.sayText);
  add("say.gloss", body.say?.gloss, CAPS.sayGloss);
  add("summary[0]", body.summary[0], CAPS.summaryGlance);
  add("summary[1]", body.summary[1], CAPS.summaryContext);
  body.facts.forEach((fact, i) => {
    add(`facts[${i}].text`, fact.text, CAPS.factText);
    add(`facts[${i}].note`, fact.note, CAPS.factNote);
  });
  add("quote", body.quote, CAPS.quote);
  return out;
}

/** The capped fields wider than their cap. Empty means the body fits. */
export function fieldsOverCap(body: CardBody): CappedField[] {
  return cappedFields(body).filter((field) => widthOf(field.text) > field.cap);
}
