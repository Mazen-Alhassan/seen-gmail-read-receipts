/**
 * Throttling for the invite code — the only secret on this server that someone could sit and
 * guess. (The API key is 256 random bits and isn't worth guessing; the pixel endpoint has to stay
 * open, because strangers' mail servers call it.)
 *
 * A few failures cost nothing, so typing your own code wrong doesn't lock you out. After that
 * each failure doubles the wait, which turns guessing from "as fast as the network allows" into
 * a handful of tries per hour.
 *
 * Two limits run together: one per address, and one across the whole server so that rotating
 * addresses doesn't sidestep it. The shared limit is deliberately slacker and tops out sooner,
 * because an attacker reaching it must not be able to lock the owner out for long.
 */

export interface Policy {
  /** Failures allowed before any waiting starts. */
  free: number;
  /** The first wait, which doubles with each further failure. */
  base: number;
  /** The longest wait this limit will ever impose. */
  max: number;
}

export const PER_ADDRESS: Policy = { free: 5, base: 10_000, max: 60 * 60_000 };
export const SHARED: Policy = { free: 50, base: 5_000, max: 5 * 60_000 };

/** Strikes stop counting against you after a quiet day. */
export const STRIKE_TTL_MS = 24 * 3_600_000;

/** How long a caller must wait after `strikes` consecutive failures. */
export function lockoutFor(policy: Policy, strikes: number): number {
  if (strikes <= policy.free) return 0;
  const doublings = strikes - policy.free - 1;
  // 2**doublings overflows into Infinity long before this matters; Math.min still does the right thing.
  return Math.min(policy.max, policy.base * 2 ** doublings);
}

interface Row {
  strikes: number;
  retry_after: number;
  updated_at: number;
}

/** Milliseconds the caller must still wait, or 0 if they may proceed. */
export async function waitRequired(db: D1Database, key: string, now: number): Promise<number> {
  const row = await db
    .prepare("SELECT strikes, retry_after, updated_at FROM rate_limits WHERE key = ?")
    .bind(key)
    .first<Row>();
  if (!row || now - row.updated_at > STRIKE_TTL_MS) return 0;
  return Math.max(0, row.retry_after - now);
}

/** Count a failed attempt and return how long the caller must now wait. */
export async function recordFailure(
  db: D1Database,
  key: string,
  policy: Policy,
  now: number,
): Promise<number> {
  const row = await db
    .prepare("SELECT strikes, retry_after, updated_at FROM rate_limits WHERE key = ?")
    .bind(key)
    .first<Row>();
  const previous = row && now - row.updated_at <= STRIKE_TTL_MS ? row.strikes : 0;
  const strikes = previous + 1;
  const retryAfter = now + lockoutFor(policy, strikes);
  await db
    .prepare(
      `INSERT INTO rate_limits (key, strikes, retry_after, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET strikes = ?, retry_after = ?, updated_at = ?`,
    )
    .bind(key, strikes, retryAfter, now, strikes, retryAfter, now)
    .run();
  return retryAfter - now;
}

/** Forget a caller's failures — they've proved they know the code. */
export async function clearFailures(db: D1Database, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db
    .prepare(`DELETE FROM rate_limits WHERE key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .run();
}

/** The address a request came from, as Cloudflare saw it. */
export function callerAddress(headers: Headers): string {
  return headers.get("CF-Connecting-IP")?.trim() || "unknown";
}
