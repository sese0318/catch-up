// Export .md (ux-spec 3 History). A download on computers, the share sheet on phones through the
// Web Share API, and a download when sharing is not possible. Export is the only path to disk.
import type { Card } from "../card/schema";
import { exportFileName } from "./format";
import { markdownOf } from "./local";

export type ExportResult = "downloaded" | "shared" | "cancelled" | "failed";

/** Cards come newest first from history. The file lists them oldest first. */
export async function exportCards(
  cardsNewestFirst: readonly Card[],
  options: { preferShare: boolean; win?: Window | null; now?: Date },
): Promise<ExportResult> {
  const win = options.win ?? (typeof window === "undefined" ? null : window);
  if (!win || cardsNewestFirst.length === 0) return "failed";
  const when = options.now ?? new Date();
  const text = markdownOf([...cardsNewestFirst].reverse(), when);
  const name = exportFileName(when);

  if (options.preferShare && typeof win.navigator.share === "function" && typeof File === "function") {
    try {
      const file = new File([text], name, { type: "text/markdown" });
      if (!win.navigator.canShare || win.navigator.canShare({ files: [file] })) {
        await win.navigator.share({ files: [file], title: name });
        return "shared";
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
      // Fall through to a download.
    }
  }

  try {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = win.document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    win.document.body.appendChild(link);
    link.click();
    link.remove();
    win.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return "downloaded";
  } catch {
    return "failed";
  }
}
