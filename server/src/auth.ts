import { b64urlEncode, importMintKey, randomBytes, tokenUserId, verifyToken } from "../../shared/token";
import type { UserRow } from "./db";

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newApiKey(): string {
  return b64urlEncode(randomBytes(32));
}

export function newMintKey(): string {
  return b64urlEncode(randomBytes(32));
}

export async function safeEqual(a: string, b: string): Promise<boolean> {
  // Compare digests so the comparison takes the same time regardless of where inputs differ.
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ---- Per-isolate caches. Workers reuse isolates across requests, so these save a D1 read on
// the hot paths (every pixel hit and every API call) without risking stale data for long. ----

const USER_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;

const usersByKeyHash = new Map<string, { user: UserRow | null; at: number }>();
const mintKeys = new Map<string, { key: CryptoKey | null; at: number }>();
/** Junk tokens/keys must not grow these forever. */
const MAX_CACHED = 2_000;

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(key, value);
}

export async function userForApiKey(db: D1Database, apiKey: string): Promise<UserRow | null> {
  const hash = await sha256Hex(apiKey);
  const cached = usersByKeyHash.get(hash);
  const now = Date.now();
  if (cached && now - cached.at < (cached.user ? USER_TTL_MS : MISS_TTL_MS)) return cached.user;
  const user = await db.prepare("SELECT * FROM users WHERE key_hash = ?").bind(hash).first<UserRow>();
  remember(usersByKeyHash, hash, { user, at: now });
  return user;
}

async function mintKeyFor(db: D1Database, userId: string): Promise<CryptoKey | null> {
  const cached = mintKeys.get(userId);
  const now = Date.now();
  if (cached && now - cached.at < (cached.key ? USER_TTL_MS : MISS_TTL_MS)) return cached.key;
  const row = await db
    .prepare("SELECT mint_key FROM users WHERE id = ?")
    .bind(userId)
    .first<{ mint_key: string }>();
  const key = row ? await importMintKey(row.mint_key) : null;
  remember(mintKeys, userId, { key, at: now });
  return key;
}

/** Returns the owning user id if `token` is authentic (signed with that user's mint key). */
export async function authenticToken(db: D1Database, token: string): Promise<string | null> {
  const userId = tokenUserId(token);
  if (!userId) return null;
  const key = await mintKeyFor(db, userId);
  if (!key) return null;
  return (await verifyToken(token, key)) ? userId : null;
}

export function forgetCachedUser(userId: string, keyHash: string): void {
  mintKeys.delete(userId);
  usersByKeyHash.delete(keyHash);
}
