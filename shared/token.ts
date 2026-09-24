/**
 * Pixel tokens.
 *
 * A token is 24 bytes, encoded as 32 base64url characters:
 *
 *   [0..8)   user id      – random, assigned by the server at registration
 *   [8..18)  nonce        – random per message
 *   [18..24) signature    – first 6 bytes of HMAC-SHA256(mintKey, bytes[0..18))
 *
 * The extension mints tokens locally (so sending never waits on the network),
 * and the server can verify a token belongs to a real user without any prior
 * registration round-trip. Forging a token for a user requires their mintKey.
 */

export const TOKEN_CHARS = 32;
export const USER_ID_CHARS = 11;
export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

const USER_ID_BYTES = 8;
const NONCE_BYTES = 10;
const SIG_BYTES = 6;
const BODY_BYTES = USER_ID_BYTES + NONCE_BYTES;

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** New random user id (8 bytes → 11 base64url chars). */
export function newUserId(): string {
  return b64urlEncode(randomBytes(USER_ID_BYTES));
}

export function importMintKey(mintKey: string): Promise<CryptoKey> {
  const raw = b64urlDecode(mintKey);
  if (!raw || raw.length < 16) throw new Error("invalid mint key");
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(key: CryptoKey, body: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return mac.subarray(0, SIG_BYTES);
}

export async function mintToken(userId: string, key: CryptoKey): Promise<string> {
  const uid = b64urlDecode(userId);
  if (!uid || uid.length !== USER_ID_BYTES) throw new Error("invalid user id");
  const bytes = new Uint8Array(BODY_BYTES + SIG_BYTES);
  bytes.set(uid, 0);
  bytes.set(randomBytes(NONCE_BYTES), USER_ID_BYTES);
  bytes.set(await sign(key, bytes.subarray(0, BODY_BYTES)), BODY_BYTES);
  return b64urlEncode(bytes);
}

/**
 * Every token of a user starts with these 10 characters (they encode the first 60 bits of the
 * user id), so a URL filter on this prefix matches exactly that user's pixels.
 */
export function tokenPrefix(userId: string): string {
  return userId.slice(0, 10);
}

/** The user id embedded in a token, or null if the token is malformed. Does not verify. */
export function tokenUserId(token: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  const bytes = b64urlDecode(token);
  if (!bytes || bytes.length !== BODY_BYTES + SIG_BYTES) return null;
  return b64urlEncode(bytes.subarray(0, USER_ID_BYTES));
}

export async function verifyToken(token: string, key: CryptoKey): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;
  const bytes = b64urlDecode(token);
  if (!bytes || bytes.length !== BODY_BYTES + SIG_BYTES) return false;
  const expected = await sign(key, bytes.subarray(0, BODY_BYTES));
  const actual = bytes.subarray(BODY_BYTES);
  let diff = 0;
  for (let i = 0; i < SIG_BYTES; i++) diff |= expected[i]! ^ actual[i]!;
  return diff === 0;
}

/** Path of the pixel on the server. Kept neutral: no "track"/"open"/"pixel" words that blocklists match on. */
export function pixelPath(token: string): string {
  return `/i/${token}.gif`;
}

/**
 * Extract a pixel token for `host` from an image URL. Handles both direct URLs and
 * Gmail's proxied form: https://ciN.googleusercontent.com/meips/…#https://host/i/<token>.gif
 */
export function extractToken(src: string, host: string): string | null {
  const needle = `//${host}/i/`;
  const at = src.lastIndexOf(needle);
  if (at === -1) return null;
  const token = src.slice(at + needle.length, at + needle.length + TOKEN_CHARS);
  return TOKEN_RE.test(token) ? token : null;
}
