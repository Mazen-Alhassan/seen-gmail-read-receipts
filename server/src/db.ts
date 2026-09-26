import type { MessageDetail, MessageSummary, Recipient } from "../../shared/api";
import {
  canonicalEmail,
  classify,
  isMicrosoftConsumer,
  summarize,
  sweepKey,
  SWEEP_WINDOW_MS,
  type Hit,
} from "./classify";

/** D1 caps bound parameters per statement at 100. */
const MAX_PARAMS = 90;

export interface UserRow {
  id: string;
  key_hash: string;
  mint_key: string;
  created_at: number;
}

export interface MessageRow {
  token: string;
  user_id: string;
  sender: string;
  subject: string;
  recipients: string;
  sent_at: number;
  thread_id: string | null;
  message_id: string | null;
  sender_ip: string | null;
  sender_ua: string | null;
  gateway: string | null;
  gateway_checked: number;
  created_at: number;
  updated_at: number;
}

interface HitRow {
  id: number;
  token: string;
  ts: number;
  ip: string | null;
  ua: string | null;
  asn: number | null;
  as_org: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
}

function chunks<T>(items: T[], size = MAX_PARAMS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** Run `SELECT … WHERE <column> IN (…)` over any number of values, chunked to fit D1's limits. */
export async function selectIn<T>(
  db: D1Database,
  sql: (inList: string) => string,
  values: string[],
  leading: unknown[] = [],
): Promise<T[]> {
  if (values.length === 0) return [];
  const results = await Promise.all(
    chunks(values, Math.max(1, MAX_PARAMS - leading.length)).map((chunk) =>
      db
        .prepare(sql(placeholders(chunk.length)))
        .bind(...leading, ...chunk)
        .all<T>(),
    ),
  );
  return results.flatMap((r) => r.results);
}

function parseRecipients(json: string): Recipient[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toHit(r: HitRow): Hit {
  return {
    ts: r.ts,
    ip: r.ip,
    ua: r.ua,
    asn: r.asn,
    asOrg: r.as_org,
    country: r.country,
    region: r.region,
    city: r.city,
  };
}

export interface LoadOptions {
  now: number;
  withEvents?: boolean;
  /** Hits younger than this are left out: a "that was me" beacon for them may still be in flight. */
  settleMs?: number;
}

/**
 * Turn message rows into summaries by loading their raw hits and self-view beacons and
 * classifying them. Classification happens here, on read, so it always sees every signal.
 */
export async function buildSummaries(
  db: D1Database,
  rows: MessageRow[],
  opts: LoadOptions,
): Promise<MessageDetail[]> {
  const tokens = rows.map((r) => r.token);
  const [hitRows, viewRows] = await Promise.all([
    selectIn<HitRow>(
      db,
      (list) => `SELECT * FROM hits WHERE token IN (${list}) ORDER BY ts ASC, id ASC`,
      tokens,
    ),
    selectIn<{ token: string; ts: number }>(
      db,
      (list) => `SELECT token, ts FROM self_views WHERE token IN (${list})`,
      tokens,
    ),
  ]);

  const hitsBy = new Map<string, Hit[]>();
  const cutoff = opts.now - (opts.settleMs ?? 0);
  for (const h of hitRows) {
    if (h.ts > cutoff) continue;
    let list = hitsBy.get(h.token);
    if (!list) hitsBy.set(h.token, (list = []));
    list.push(toHit(h));
  }
  const viewsBy = new Map<string, number[]>();
  for (const v of viewRows) {
    let list = viewsBy.get(v.token);
    if (!list) viewsBy.set(v.token, (list = []));
    list.push(v.ts);
  }

  const userId = rows[0]?.user_id;
  const sweptHits = userId && hitRows.length ? await findSweptHits(db, userId, hitRows) : undefined;

  return rows.map((row) => {
    const recipients = parseRecipients(row.recipients);
    const classified = classify(
      {
        sentAt: row.sent_at,
        senderIp: row.sender_ip,
        senderUa: row.sender_ua,
        gateway: row.gateway,
        microsoftConsumer: recipients.some((r) => isMicrosoftConsumer(r.email)),
        ...selfRecipient(row.sender, recipients),
        recipientCount: recipients.length,
        sweptHits,
      },
      hitsBy.get(row.token) ?? [],
      viewsBy.get(row.token) ?? [],
    );
    const summary: MessageSummary = {
      token: row.token,
      sender: row.sender,
      subject: row.subject,
      recipients,
      sentAt: row.sent_at,
      threadId: row.thread_id,
      messageId: row.message_id,
      ...summarize(classified),
    };
    return {
      ...summary,
      events: opts.withEvents
        ? classified.map((c) => ({ at: c.hit.ts, kind: c.kind, client: c.client, detail: c.detail }))
        : [],
    };
  });
}

/**
 * Find hits that were one address fetching pixels from several different emails at once.
 *
 * A recipient only ever holds the email you sent *them*, so a single address pulling pixels out of
 * emails that went to different people is your own mailbox, not theirs — typically your phone
 * rendering replies that quote your original message, tracking pixel and all. Those fetches say
 * nothing about whether the recipient read anything, and left alone they mark long-dead emails as
 * "delivered" (or worse, opened) days after the fact.
 *
 * If one person received every email in the burst, it really may be them, so it isn't a sweep.
 */
async function findSweptHits(db: D1Database, userId: string, hits: HitRow[]): Promise<Set<string>> {
  const swept = new Set<string>();
  const ips = [...new Set(hits.map((h) => h.ip).filter((ip): ip is string => !!ip))];
  if (ips.length === 0) return swept;

  const timestamps = hits.map((h) => h.ts);
  const rows = await selectIn<{ ts: number; ip: string; token: string }>(
    db,
    (list) =>
      `SELECT ts, ip, token FROM hits WHERE user_id = ? AND ts >= ? AND ts <= ? AND ip IN (${list})`,
    ips,
    [userId, Math.min(...timestamps) - SWEEP_WINDOW_MS, Math.max(...timestamps) + SWEEP_WINDOW_MS],
  );

  // Group each address's fetches into bursts, and keep the bursts that span several emails.
  const byIp = new Map<string, { ts: number; token: string }[]>();
  for (const r of rows) {
    let list = byIp.get(r.ip);
    if (!list) byIp.set(r.ip, (list = []));
    list.push({ ts: r.ts, token: r.token });
  }
  const bursts: { ip: string; rows: { ts: number; token: string }[] }[] = [];
  for (const [ip, list] of byIp) {
    list.sort((a, b) => a.ts - b.ts);
    let current: { ts: number; token: string }[] = [];
    for (const row of list) {
      if (current.length && row.ts - current[current.length - 1]!.ts > SWEEP_WINDOW_MS) {
        bursts.push({ ip, rows: current });
        current = [];
      }
      current.push(row);
    }
    if (current.length) bursts.push({ ip, rows: current });
  }
  const candidates = bursts.filter((b) => new Set(b.rows.map((r) => r.token)).size > 1);
  if (candidates.length === 0) return swept;

  const tokens = [...new Set(candidates.flatMap((b) => b.rows.map((r) => r.token)))];
  const messageRows = await selectIn<{ token: string; recipients: string }>(
    db,
    (list) => `SELECT token, recipients FROM messages WHERE token IN (${list})`,
    tokens,
  );
  const recipientsBy = new Map(
    messageRows.map((m) => [m.token, new Set(parseRecipients(m.recipients).map((r) => canonicalEmail(r.email)))]),
  );

  for (const burst of candidates) {
    const sets = [...new Set(burst.rows.map((r) => r.token))].map((t) => recipientsBy.get(t) ?? new Set<string>());
    const shared = sets.reduce((acc, set) => new Set([...acc].filter((e) => set.has(e))));
    if (shared.size > 0) continue; // one person got all of them — it really could be them
    for (const row of burst.rows) swept.add(sweepKey({ ts: row.ts, ip: burst.ip }));
  }
  return swept;
}

function selfRecipient(sender: string, recipients: Recipient[]): { toSelfOnly: boolean; selfAmongRecipients: boolean } {
  const me = sender.trim() ? canonicalEmail(sender) : "";
  const isMe = recipients.map((r) => canonicalEmail(r.email) === me);
  return {
    toSelfOnly: !!me && isMe.length > 0 && isMe.every(Boolean),
    selfAmongRecipients: !!me && isMe.some(Boolean) && !isMe.every(Boolean),
  };
}

export function stripEvents({ events: _events, ...summary }: MessageDetail): MessageSummary {
  return summary;
}
