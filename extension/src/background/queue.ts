/**
 * Durable outbox for server writes. Sending an email must never depend on the network, so
 * registrations are queued in chrome.storage and retried with backoff until they land —
 * surviving service-worker restarts, offline periods and browser restarts.
 */

import type { PutMessageRequest } from "../../../shared/api";
import type { Connection } from "../lib/config";
import { ApiError, call } from "./api";

export type Op =
  | { kind: "put"; token: string; message: PutMessageRequest; attempts: number; nextAt: number }
  | { kind: "delete"; token: string; attempts: number; nextAt: number };

export type NewOp = { kind: "put"; token: string; message: PutMessageRequest } | { kind: "delete"; token: string };

type Queue = Record<string, Op>;

const KEY = "outbox";
const MAX_BACKOFF_MS = 30 * 60_000;
const GIVE_UP_AFTER = 200; // ≈ 4 days at max backoff

/** Storage writes from concurrent handlers must not interleave, so every mutation is serialised. */
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

async function load(): Promise<Queue> {
  const { [KEY]: q } = await chrome.storage.local.get(KEY);
  return (q as Queue | undefined) ?? {};
}

async function save(q: Queue): Promise<void> {
  await chrome.storage.local.set({ [KEY]: q });
}

/** Merge an update into whatever is already queued for this email. */
export function merge(existing: Op | undefined, next: Op): Op {
  // Once an email is untracked (e.g. its send was undone), a late update must not bring it back.
  if (existing?.kind === "delete") return existing;
  if (next.kind === "delete" || !existing) return next;
  return {
    ...next,
    message: {
      ...existing.message,
      ...next.message,
      threadId: next.message.threadId ?? existing.message.threadId ?? null,
      messageId: next.message.messageId ?? existing.message.messageId ?? null,
    },
  };
}

const TOMBSTONES = "untracked";
const TOMBSTONE_TTL_MS = 30 * 86400_000;

async function tombstones(): Promise<Record<string, number>> {
  const { [TOMBSTONES]: t } = await chrome.storage.local.get(TOMBSTONES);
  return (t as Record<string, number> | undefined) ?? {};
}

async function addTombstone(token: string, now: number): Promise<void> {
  const all = await tombstones();
  const kept = Object.fromEntries(Object.entries(all).filter(([, at]) => now - at < TOMBSTONE_TTL_MS));
  kept[token] = now;
  await chrome.storage.local.set({ [TOMBSTONES]: kept });
}

export function enqueue(op: NewOp): Promise<void> {
  return exclusive(async () => {
    // Never re-register an email that's already been untracked.
    if (op.kind === "put" && (await tombstones())[op.token] !== undefined) return;
    const q = await load();
    q[op.token] = merge(q[op.token], { ...op, attempts: 0, nextAt: 0 });
    await save(q);
  });
}

export function pendingCount(): Promise<number> {
  return load().then((q) => Object.keys(q).length);
}

export function clear(): Promise<void> {
  return exclusive(() => save({}));
}

export function backoff(attempts: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/** Try every op that's due. Returns how many are still waiting. */
export function flush(conn: Connection, now = Date.now()): Promise<number> {
  return exclusive(async () => {
    const q = await load();
    let offline = false;
    for (const op of Object.values(q)) {
      if (op.nextAt > now) continue;
      // Once we know the network is down, back everything off together instead of trying each.
      if (offline) {
        op.nextAt = now + backoff(Math.max(op.attempts, 1));
        continue;
      }
      try {
        // clientNow lets the server correct for this computer's clock being off.
        if (op.kind === "put") await call(conn, "PUT", `/api/messages/${op.token}`, { ...op.message, clientNow: Date.now() });
        else {
          await call(conn, "DELETE", `/api/messages/${op.token}`);
          await addTombstone(op.token, now);
        }
        delete q[op.token];
      } catch (err) {
        const retry = err instanceof ApiError ? err.retryable || err.status === 401 : true;
        op.attempts++;
        if (!retry || op.attempts >= GIVE_UP_AFTER) {
          console.warn("[Seen] dropping queued", op.kind, op.token, err);
          delete q[op.token];
        } else {
          op.nextAt = now + backoff(op.attempts);
          if (err instanceof ApiError && err.status === 0) offline = true;
        }
      }
    }
    await save(q);
    return Object.keys(q).length;
  });
}
