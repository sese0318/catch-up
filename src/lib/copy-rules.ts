// Writing rules for user-facing English (UI copy, README, docs, error messages).
// No em dash or en dash as punctuation, no hyphen or slash as a separator, no semicolons,
// no colons in sentences or labels, and none of the banned words. Inline code, URLs, file paths,
// model ids, clock times and number ranges are exempt. Use it in tests to check copy before it ships.

export const COPY_BANNED_WORDS = [
  "delve",
  "crucial",
  "leverage",
  "landscape",
  "tapestry",
  "multifaceted",
  "utilize",
  "underscore",
  "foster",
  "navigate",
  "realm",
  "robust",
  "seamless",
  "comprehensive",
  "harness",
  "pivotal",
  "nuanced",
  "intricate",
  "commenced",
] as const;

export type CopyProblem =
  | "em_dash"
  | "en_dash"
  | "hyphen_separator"
  | "slash"
  | "semicolon"
  | "colon"
  | `word:${(typeof COPY_BANNED_WORDS)[number]}`;

/** Problems found in one piece of copy. An empty array means it follows the rules. */
export function copyRuleProblems(text: string): CopyProblem[] {
  const problems = new Set<CopyProblem>();
  const t = text
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ") // URLs
    .replace(/\bmeta-models\/[A-Za-z0-9][\w.-]*/g, " ") // model ids such as meta-models/muse-spark-open-1026
    .replace(/(^|\s)\.{0,2}\/[\w./{},-]+/g, " ") // absolute and relative paths such as /api/card
    .replace(/[\w.{},-]+\/[\w./{},-]*\.[a-z0-9]{1,5}\b/gi, " ") // file paths such as src/lib/protocol.ts
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " "); // clock times
  if (/—/.test(t)) problems.add("em_dash");
  if (/(?<!\d)–|–(?!\d)/.test(t)) problems.add("en_dash"); // 13–19 is a number range
  if (/\S\s+-\s+\S/.test(t) || /\S\s+-\s*$/m.test(t)) problems.add("hyphen_separator");
  if (/[A-Za-z]\/[A-Za-z]/.test(t)) problems.add("slash");
  if (t.includes(";")) problems.add("semicolon");
  if (t.includes(":")) problems.add("colon");
  for (const word of COPY_BANNED_WORDS) {
    if (new RegExp(`\\b${word}`, "i").test(t)) problems.add(`word:${word}`);
  }
  return [...problems];
}
