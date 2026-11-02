// Checks user-facing English against the writing rules with copyRuleProblems (src/lib/copy-rules.ts).
// Scans JSX text, copy attributes and prose-like strings in src/app, src/components and the UI copy
// module, and the prose of README.md. Model ids, URLs, paths, inline code and clock times are exempt.
//   npx tsx scripts/check-copy.ts            the default folders and README.md
//   npx tsx scripts/check-copy.ts FILES...   only these files or folders
//   npx tsx scripts/check-copy.ts --json     findings as JSON
// Exits 1 when it finds a problem.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { copyRuleProblems, type CopyProblem } from "@/lib/copy-rules";

export type CopyWhere = "jsx" | "attribute" | "string" | "template" | "markdown";

export interface CopyString {
  line: number; // 1-based
  text: string;
  where: CopyWhere;
}

export interface CopyFinding extends CopyString {
  file: string;
  problems: CopyProblem[];
}

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const DEFAULT_TARGETS = ["src/app", "src/components", "src/lib/client/copy.ts", "README.md"] as const;

/** JSX attributes that hold words people read or hear. */
const COPY_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "label",
  "placeholder",
  "summary",
  "title",
]);

/** Object keys and JSX attributes whose values are identifiers, styles or addresses, never copy. */
const NON_COPY_KEYS = new Set([
  "accept",
  "as",
  "autoComplete",
  "className",
  "code",
  "d",
  "dir",
  "event",
  "fill",
  "href",
  "htmlFor",
  "id",
  "inputMode",
  "key",
  "kind",
  "lang",
  "method",
  "mode",
  "name",
  "path",
  "pattern",
  "rel",
  "role",
  "route",
  "size",
  "src",
  "stroke",
  "style",
  "target",
  "type",
  "url",
  "variant",
  "viewBox",
  "xmlns",
]);

/** Calls whose string arguments are selectors, class names, storage keys or patterns. console.* is skipped too. */
const NON_COPY_CALLS = new Set([
  "addEventListener",
  "clsx",
  "cn",
  "createElement",
  "cva",
  "endsWith",
  "fetch",
  "getAttribute",
  "getElementById",
  "getItem",
  "includes",
  "match",
  "matchMedia",
  "querySelector",
  "querySelectorAll",
  "removeEventListener",
  "removeItem",
  "replace",
  "require",
  "setAttribute",
  "setItem",
  "split",
  "startsWith",
  "test",
  "twMerge",
]);

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.InKeyword,
]);

/** A run of utility classes such as "flex items-center gap-2". */
function isClassList(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  return tokens.every((t) => /^[!-]?[a-z0-9@[\]().%#/_:-]+$/.test(t)) && tokens.some((t) => /[-:[]/.test(t));
}

/** Inline scripts, CSS and other code kept in strings. */
function looksLikeCode(text: string): boolean {
  return /[{}]|=>|\b(var|let|const|function|return)\s|\w\([^)]*\)\s*[;.]|;\s*\w+\s*[=(]/.test(text);
}

/** Strings that read like words for people, not ids, keys, paths, class names or code. */
export function looksLikeCopy(raw: string): boolean {
  const text = raw.trim();
  if (text.length < 2 || !/[A-Za-z]/.test(text)) return false;
  if (/^(https?:|mailto:|data:|\/|\.{1,2}\/|#)/.test(text)) return false;
  if (looksLikeCode(text)) return false;
  if (!/\s/.test(text)) return /^[A-Z][a-z]+[.!?]?$/.test(text);
  if (isClassList(text)) return false;
  return /[A-Za-z][A-Za-z']*[,.!?]?\s+[A-Za-z]/.test(text);
}

function nameOf(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function jsxAttributeName(attr: ts.JsxAttribute): string {
  return ts.isIdentifier(attr.name) ? attr.name.text : `${attr.name.namespace.text}:${attr.name.name.text}`;
}

/** Why a string literal is not copy, or null when it should be checked. */
function skipReason(node: ts.Node): string | null {
  const parent = node.parent;
  if (!parent) return "root";
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return "module";
  if (ts.isLiteralTypeNode(parent)) return "type";
  if (ts.isExpressionStatement(parent)) return "directive";
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node) return "key";
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return "key";
  if (ts.isCaseClause(parent)) return "case";
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return "comparison";
  if (ts.isPropertyAssignment(parent) && NON_COPY_KEYS.has(nameOf(parent.name) ?? "")) return "technical key";
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(node as ts.Expression)) {
    const callee = nameOf(parent.expression);
    const target = parent.expression;
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === "console") return "console";
    if (callee && NON_COPY_CALLS.has(callee)) return "technical call";
    if (ts.isNewExpression(parent) && callee && /Error$|^(URL|Request|Response|Headers|RegExp)$/.test(callee)) return "technical call";
  }
  for (let up: ts.Node | undefined = parent; up; up = up.parent) {
    if (ts.isJsxAttribute(up)) return COPY_ATTRIBUTES.has(jsxAttributeName(up)) ? null : "attribute";
    if (ts.isJsxElement(up) || ts.isJsxSelfClosingElement(up) || ts.isBlock(up) || ts.isSourceFile(up)) break;
  }
  return null;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** The strings in a TS or TSX file that people will read. */
export function extractCopyFromSource(code: string, fileName: string): CopyString[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const out: CopyString[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      if (/[A-Za-z]/.test(text)) out.push({ line: lineOf(source, node), text, where: "jsx" });
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      if (COPY_ATTRIBUTES.has(jsxAttributeName(node)) && /[A-Za-z]/.test(node.initializer.text)) {
        out.push({ line: lineOf(source, node), text: node.initializer.text, where: "attribute" });
      }
      return;
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!skipReason(node) && looksLikeCopy(node.text)) out.push({ line: lineOf(source, node), text: node.text, where: "string" });
    } else if (ts.isTemplateExpression(node)) {
      const text = [node.head.text, ...node.templateSpans.map((s) => `0${s.literal.text}`)].join("");
      if (!skipReason(node) && looksLikeCopy(text)) out.push({ line: lineOf(source, node), text, where: "template" });
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The prose lines of a Markdown file, without code, links, markers or table rules. */
export function extractCopyFromMarkdown(markdown: string): CopyString[] {
  const out: CopyString[] = [];
  let fence: string | null = null;
  let comment = false;
  markdown.split(/\r?\n/).forEach((raw, i) => {
    const fenceMark = /^\s*(```|~~~)/.exec(raw);
    if (fenceMark) {
      if (fence === null) fence = fenceMark[1];
      else if (fenceMark[1] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    let line = raw;
    if (comment) {
      const end = line.indexOf("-->");
      if (end < 0) return;
      comment = false;
      line = line.slice(end + 3);
    }
    line = line.replace(/<!--.*?-->/g, " ");
    const open = line.indexOf("<!--");
    if (open >= 0) {
      comment = true;
      line = line.slice(0, open);
    }
    if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) return; // table rule
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(line)) return; // link reference
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return; // horizontal rule
    const text = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<https?:\/\/[^>]+>/g, " ")
      .replace(/<\/?[a-z][^>]*>/gi, " ")
      .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
      .replace(/\*\*|__/g, "")
      .replace(/\s*\|\s*/g, " | ")
      .trim();
    if (/[A-Za-z]/.test(text)) out.push({ line: i + 1, text, where: "markdown" });
  });
  return out;
}

/** Problems in one string. Table pipes are cell borders, not copy. */
function problemsIn(item: CopyString): CopyProblem[] {
  if (item.where !== "markdown") return copyRuleProblems(item.text);
  return [...new Set(item.text.split(" | ").flatMap((cell) => copyRuleProblems(cell)))];
}

function walk(path: string, out: string[]): void {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(join(path, name), out);
    }
    return;
  }
  const ext = extname(path);
  if ((ext === ".ts" || ext === ".tsx" || ext === ".md") && !/\.test\.tsx?$/.test(path) && !path.endsWith(".d.ts")) out.push(path);
}

export function checkFiles(targets: readonly string[], root: string = ROOT): CopyFinding[] {
  const files: string[] = [];
  for (const target of targets) walk(resolve(root, target), files);
  const findings: CopyFinding[] = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const items = path.endsWith(".md") ? extractCopyFromMarkdown(text) : extractCopyFromSource(text, path);
    const file = relative(root, path).replace(/\\/g, "/");
    for (const item of items) {
      const problems = problemsIn(item);
      if (problems.length > 0) findings.push({ ...item, file, problems });
    }
  }
  return findings;
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const targets = argv.filter((a) => !a.startsWith("--"));
  const findings = checkFiles(targets.length > 0 ? targets : DEFAULT_TARGETS);
  if (json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    for (const f of findings) {
      const excerpt = f.text.length > 100 ? `${f.text.slice(0, 97)}...` : f.text;
      console.log(`${f.file} line ${f.line}, ${f.problems.join(" and ")} in "${excerpt}"`);
    }
    console.log(findings.length === 0 ? "Copy follows the writing rules." : `${findings.length} strings break the writing rules.`);
  }
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
