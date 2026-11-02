// Who a press comes from and where, for the press guards and Meta's geographic use policy. Server only.
// Only Vercel's own headers are trusted, and only on Vercel. Off Vercel every forwarding header is
// ignored, because Next sets x-forwarded-for only when it is missing and a tunnel appends to it,
// so a client could pick a fresh rate limit key for each request.
import { LOCAL_CLIENT_KEY, type CardHandlerDeps } from "../providers/types";

function onVercel(): boolean {
  return Boolean(process.env.VERCEL);
}

/** The /64 prefix of an IPv6 address (one home or one phone network), the IPv4 inside a mapped address, else null. */
export function ipv6Prefix64(ip: string): string | null {
  const raw = ip.trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!raw.includes(":")) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  if (raw.includes(".")) return null; // other embedded IPv4 forms are kept whole
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * The rate limit key. deps.clientKey first (the eval passes one per run). On Vercel, x-real-ip,
 * with an IPv6 address cut to its /64. Anywhere else LOCAL_CLIENT_KEY, one bucket for the machine.
 */
export function clientKeyOf(req: Request, custom?: CardHandlerDeps["clientKey"]): string {
  if (custom) {
    try {
      const key = custom(req);
      if (key) return key;
    } catch {
      // fall through
    }
  }
  if (!onVercel()) return LOCAL_CLIENT_KEY;
  const ip = req.headers.get("x-real-ip")?.trim();
  if (!ip) return LOCAL_CLIENT_KEY;
  return ipv6Prefix64(ip) ?? ip;
}

/**
 * Meta's Geographic Use Policy (https://dev.meta.ai/legal/geographic-use-policy, updated 2026-10-12)
 * as ISO 3166-1 codes. Crimea, Donetsk and Luhansk are regions of UA, listed below.
 */
const META_RESTRICTED_COUNTRIES: ReadonlySet<string> = new Set([
  "AF", // Afghanistan
  "BY", // Belarus
  "KH", // Cambodia
  "CN", // People's Republic of China
  "HK", // Hong Kong SAR
  "MO", // Macau SAR
  "CU", // Cuba
  "ER", // Eritrea
  "ET", // Ethiopia
  "HT", // Haiti
  "IR", // Iran
  "IQ", // Iraq
  "LY", // Libya
  "MM", // Myanmar
  "NI", // Nicaragua
  "KP", // North Korea
  "PK", // Pakistan
  "RU", // Russia
  "SO", // Somalia
  "SY", // Syria
  "VE", // Venezuela
  "EH", // Western Sahara
]);

/** ISO 3166-2 regions of Ukraine on the list. Crimea, Sevastopol, Donetsk and Luhansk. */
const META_RESTRICTED_UA_REGIONS: ReadonlySet<string> = new Set(["43", "40", "14", "09"]);

/**
 * True when Vercel places the caller in a territory where the Meta Model API may not be offered.
 * Off Vercel there is no trusted location, so this is always false.
 */
export function metaApiBlockedHere(req: Request): boolean {
  if (!onVercel()) return false;
  const country = req.headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (!country) return false;
  if (META_RESTRICTED_COUNTRIES.has(country)) return true;
  if (country !== "UA") return false;
  const region = (req.headers.get("x-vercel-ip-country-region") ?? "").trim().toUpperCase().replace(/^UA-/, "");
  return META_RESTRICTED_UA_REGIONS.has(region);
}
