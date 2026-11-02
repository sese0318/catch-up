import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkFiles, extractCopyFromMarkdown, extractCopyFromSource, looksLikeCopy } from "./check-copy";

const texts = (code: string, file = "x.tsx") => extractCopyFromSource(code, file).map((s) => s.text);

describe("looksLikeCopy", () => {
  it("keeps prose and capitalized labels", () => {
    expect(looksLikeCopy("Start listening")).toBe(true);
    expect(looksLikeCopy("Nothing was sent. Your clip stays in memory for 2 minutes.")).toBe(true);
    expect(looksLikeCopy("Pause")).toBe(true);
  });

  it("drops ids, classes, paths, URLs and code", () => {
    expect(looksLikeCopy("listening")).toBe(false);
    expect(looksLikeCopy("audio/wav")).toBe(false);
    expect(looksLikeCopy("flex items-center gap-2 md:hidden")).toBe(false);
    expect(looksLikeCopy("/api/card")).toBe(false);
    expect(looksLikeCopy("https://example.com/a b")).toBe(false);
    expect(looksLikeCopy("text/event-stream; charset=utf-8")).toBe(false);
    expect(looksLikeCopy("try{var s=JSON.parse(x);document.title=s}catch(e){}")).toBe(false);
    expect(looksLikeCopy("下周三")).toBe(false);
  });
});

describe("extractCopyFromSource", () => {
  it("reads JSX text, copy attributes and labels, and skips styling and wiring", () => {
    const code = `
      "use client";
      import { cn } from "./cn";
      type Mode = "Asked you" | "Nothing asked";
      const LABELS = { label: "Copy line", className: "flex items-center gap-2", hint: "Names or topics to expect" };
      export function Row({ mode }: { mode: Mode }) {
        if (mode === "Asked you") console.log("debug only: here");
        const t = \`Sent the last \${30} s of audio\`;
        return (
          <div className={cn("px-2 text-sm", mode && "font-bold")} aria-label="Card history" data-x="a: b">
            Press once to catch up
            <img alt="Panel preview" src="/a.png" />
            {t}
          </div>
        );
      }
      throw new Error("not: shown to people");
    `;
    expect(texts(code)).toEqual([
      "Copy line",
      "Names or topics to expect",
      "Sent the last 0 s of audio",
      "Card history",
      "Press once to catch up",
      "Panel preview",
    ]);
  });

  it("checks string literals inside copy attributes and skips them elsewhere", () => {
    expect(texts(`<b title={"Saved result"} className={"text-sm font-bold"} />`)).toEqual(["Saved result"]);
  });

  it("reports the line of each string", () => {
    const items = extractCopyFromSource(`const a = 1;\nconst b = "Pause listening";\n`, "x.ts");
    expect(items).toEqual([{ line: 2, text: "Pause listening", where: "string" }]);
  });
});

describe("extractCopyFromMarkdown", () => {
  it("keeps prose and drops code, table rules, comments and link targets", () => {
    const md = [
      "# Catch Up",
      "",
      "Missed something? Press once. See [the docs](docs/ARCHITECTURE.md).",
      "",
      "```bash",
      "npm run eval -- --route open_weights",
      "```",
      "",
      "| Route | Model |",
      "| - | - |",
      "| Route B | `meta-models/muse-spark-open-1026` |",
      "<!-- note: hidden -->",
      "- Built with Muse Spark Open",
      "[ref]: https://example.com",
    ].join("\n");
    expect(extractCopyFromMarkdown(md).map((s) => [s.line, s.text])).toEqual([
      [1, "Catch Up"],
      [3, "Missed something? Press once. See the docs."],
      [9, "| Route | Model |"],
      [11, "| Route B | `meta-models/muse-spark-open-1026` |"],
      [13, "Built with Muse Spark Open"],
    ]);
  });
});

describe("checkFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-copy-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds rule breaks in UI files and Markdown, and skips tests", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "Bad.tsx"), `export const B = () => <p>Note: this is a seamless flow</p>;\n`);
    writeFileSync(join(dir, "src", "Good.tsx"), `export const G = () => <p aria-label="Catch up">Sent 30 s at 10:42. Nothing saved.</p>;\n`);
    writeFileSync(join(dir, "src", "Bad.test.tsx"), `export const T = () => <p>Note: ignored</p>;\n`);
    writeFileSync(join(dir, "README.md"), "Run it - then press.\n\nUse `a:b` and tab/window audio.\n");
    const findings = checkFiles(["src", "README.md"], dir);
    expect(findings.map((f) => [f.file, f.line, f.problems])).toEqual([
      ["src/Bad.tsx", 1, ["colon", "word:seamless"]],
      ["README.md", 1, ["hyphen_separator"]],
      ["README.md", 3, ["slash"]],
    ]);
  });
});
