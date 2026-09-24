/**
 * Client-side cache of email statuses for the Gmail UI.
 *
 * Views ask for statuses by pixel token, Gmail thread id or Gmail message id. Requests made in
 * the same moment (e.g. 50 thread rows rendering) are batched into one lookup, results are
 * cached briefly, and subscribers are told when anything they watch changes.
 */

import type { MessageSummary } from "../../../shared/api";

export type Key = `t:${string}` | `th:${string}` | `m:${string}`;

export type Lookup = (q: {
  tokens: string[];
  threadIds: string[];
  messageIds: string[];
}) => Promise<MessageSummary[]>;

const BATCH_DELAY_MS = 120;
const FRESH_MS = 45_000;
const MAX_PER_KIND = 200;

export class StatusStore {
  private readonly byToken = new Map<string, MessageSummary>();
  private readonly index = new Map<Key, Set<string>>();
  private readonly fetchedAt = new Map<Key, number>();
  private readonly listeners = new Map<Key, Set<() => void>>();
  private readonly wanted = new Set<Key>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly lookup: Lookup,
    private readonly now: () => number = Date.now,
  ) {}

  /** All known summaries for a key, newest first. */
  get(key: Key): MessageSummary[] {
    const tokens = this.index.get(key);
    if (!tokens) return [];
    return [...tokens]
      .map((t) => this.byToken.get(t))
      .filter((s): s is MessageSummary => !!s)
      .sort((a, b) => b.sentAt - a.sentAt);
  }

  /** Newest summary for a key, or null. */
  latest(key: Key): MessageSummary | null {
    return this.get(key)[0] ?? null;
  }

  subscribe(key: Key, fn: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    this.ensure(key);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  /** Fetch a key unless we have a fresh answer (including a fresh "not tracked"). */
  ensure(key: Key, force = false): void {
    const at = this.fetchedAt.get(key);
    if (!force && at !== undefined && this.now() - at < FRESH_MS) return;
    this.wanted.add(key);
    this.timer ??= setTimeout(() => void this.flush(), BATCH_DELAY_MS);
  }

  /** Re-fetch everything currently on screen (called on "opened" pushes and periodically). */
  refreshWatched(): void {
    for (const key of this.listeners.keys()) this.ensure(key, true);
  }

  /** Put a summary in directly (e.g. right after sending, before the server knows about it). */
  put(summary: MessageSummary): void {
    this.store(summary);
    this.notify(this.keysFor(summary));
  }

  forget(token: string): void {
    const s = this.byToken.get(token);
    if (!s) return;
    this.byToken.delete(token);
    for (const key of this.keysFor(s)) this.index.get(key)?.delete(token);
    this.notify(this.keysFor(s));
  }

  async flush(): Promise<void> {
    this.timer = null;
    const keys = [...this.wanted];
    this.wanted.clear();
    if (keys.length === 0) return;

    const tokens: string[] = [];
    const threadIds: string[] = [];
    const messageIds: string[] = [];
    const deferred: Key[] = [];
    for (const key of keys) {
      const [kind, id] = split(key);
      const list = kind === "t" ? tokens : kind === "th" ? threadIds : messageIds;
      if (list.length < MAX_PER_KIND) list.push(id);
      else deferred.push(key);
    }

    let results: MessageSummary[];
    try {
      results = await this.lookup({ tokens, threadIds, messageIds });
    } catch (err) {
      console.debug("[Seen] status lookup failed", err);
      return; // leave uncached; the next render or refresh retries
    }

    const at = this.now();
    for (const key of keys) {
      if (deferred.includes(key)) continue;
      this.fetchedAt.set(key, at);
      // A fresh answer replaces what we knew for this key.
      if (!key.startsWith("t:")) this.index.get(key)?.clear();
    }
    const touched = new Set<Key>(keys);
    for (const s of results) {
      this.store(s);
      for (const k of this.keysFor(s)) touched.add(k);
    }
    this.notify(touched);
    for (const key of deferred) this.ensure(key, true);
  }

  private store(s: MessageSummary): void {
    this.byToken.set(s.token, s);
    for (const key of this.keysFor(s)) {
      let set = this.index.get(key);
      if (!set) this.index.set(key, (set = new Set()));
      set.add(s.token);
    }
  }

  private keysFor(s: MessageSummary): Key[] {
    const keys: Key[] = [`t:${s.token}`];
    if (s.threadId) keys.push(`th:${s.threadId}`);
    if (s.messageId) keys.push(`m:${s.messageId}`);
    return keys;
  }

  private notify(keys: Iterable<Key>): void {
    for (const key of keys) {
      for (const fn of this.listeners.get(key) ?? []) {
        try {
          fn();
        } catch (err) {
          console.error("[Seen] listener failed", err);
        }
      }
    }
  }
}

function split(key: Key): ["t" | "th" | "m", string] {
  const i = key.indexOf(":");
  return [key.slice(0, i) as "t" | "th" | "m", key.slice(i + 1)];
}
