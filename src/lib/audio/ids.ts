// Random ids for snapshots, presses, cards and the page session. base64url, so they match the
// header pattern ^[A-Za-z0-9_-]{8,64}$.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function randomId(bytes: number = 12): string {
  const buf = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (let i = 0; i < buf.length; i++) out += ALPHABET[buf[i] & 63];
  return out;
}
