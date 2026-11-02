// One log line per press (ARCHITECTURE, Privacy invariants 5). Server only.
import type { PressLogEntry } from "../providers/types";

/** Writes only the PressLogEntry fields as one JSON line. Never audio, text, names, hints, IPs or keys. */
export function logPress(entry: PressLogEntry): void {
  const line: PressLogEntry = {
    at: entry.at,
    status: entry.status,
    route: entry.route,
    model: entry.model,
    fallback: entry.fallback,
    cause: entry.cause,
    code: entry.code,
    parse: entry.parse,
    windowSec: entry.windowSec,
    sentSec: entry.sentSec,
    bytes: entry.bytes,
    ms: { total: entry.ms.total, firstToken: entry.ms.firstToken, asr: entry.ms.asr },
  };
  console.info(JSON.stringify(line));
}
