import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type {
  EventsResponse,
  ListResponse,
  LookupResponse,
  OpenNotification,
  Recipient,
  RegisterResponse,
} from "../../shared/api";
import { TOKEN_RE, newUserId, tokenUserId } from "../../shared/token";
import {
  authenticToken,
  forgetCachedUser,
  newApiKey,
  newMintKey,
  safeEqual,
  sha256Hex,
  userForApiKey,
} from "./auth";
import { buildSummaries, selectIn, stripEvents, type MessageRow, type UserRow } from "./db";
import type { Env } from "./env";
import { detectGateway, dohResolveMx, type MxResolver } from "./gateways";
import { pixelResponse } from "./pixel";

/** Hits younger than this aren't shown yet, in case a "that was me" beacon is still in flight. */
export const UI_SETTLE_MS = 8_000;
/** Notifications wait longer, so a late beacon can never produce a false "opened" alert. */
export const EVENTS_SETTLE_MS = 30_000;
/** Emails examined per notification poll. */
const EVENTS_PAGE = 200;
/** More image loads than this for one email are ignored (they'd only be someone hammering it). */
const MAX_HITS_PER_EMAIL = 300;
/** How far back a poll may reach: a week away still counts, but months of history never replay. */
const EVENTS_MAX_LOOKBACK_MS = 7 * 24 * 3600_000;

type AppEnv = { Bindings: Env; Variables: { user: UserRow } };
type Ctx = Context<AppEnv>;

export const app = new Hono<AppEnv>();

// The extension calls us from its service worker (a chrome-extension:// origin), so every route
// needs CORS. Auth is a bearer token, never cookies, so allowing any origin is safe.
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    maxAge: 86400,
  }),
);

// ---------------------------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------------------------

app.get("/", (c) =>
  c.html(
    `<!doctype html><meta charset="utf-8"><title>Seen</title>` +
      `<body style="font:15px system-ui;margin:3rem;color:#3c4043">` +
      `<p><b>Seen</b> server is running.</p></body>`,
  ),
);
app.get("/health", (c) => c.json({ ok: true }));
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

// The pixel. Always answers instantly with the image; recording happens after the response.
app.on(["GET", "HEAD"], "/i/:file", (c) => {
  const token = c.req.param("file").replace(/\.gif$/i, "");
  if (c.req.method === "GET" && TOKEN_RE.test(token)) {
    c.executionCtx.waitUntil(
      recordHit(c.env, token, c.req.raw).catch((err) => console.error("recordHit failed", err)),
    );
  }
  return pixelResponse(c.req.method === "HEAD");
});

/** Request headers worth keeping for (re)classification. */
const KEPT_HEADERS = [
  "accept",
  "accept-language",
  "accept-encoding",
  "referer",
  "via",
  "x-forwarded-for",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-ch-ua",
];

async function recordHit(env: Env, token: string, req: Request): Promise<void> {
  const userId = await authenticToken(env.DB, token);
  if (!userId) return; // forged or unknown — ignore silently
  const cf = (req as Request & { cf?: IncomingRequestCfProperties }).cf;
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = req.headers.get(name);
    if (v) headers[name] = v.slice(0, 256);
  }
  // Capped per email, so someone reloading the image in a loop can't flood the database.
  const insert = env.DB.prepare(
    `INSERT INTO hits (token, user_id, ts, ip, ua, asn, as_org, country, region, city, headers)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM hits WHERE token = ?) < ${MAX_HITS_PER_EMAIL}`,
  ).bind(
    token,
    userId,
    Date.now(),
    req.headers.get("CF-Connecting-IP"),
    clip(req.headers.get("User-Agent"), 512),
    typeof cf?.asn === "number" ? cf.asn : null,
    clip(cf?.asOrganization, 128),
    clip(cf?.country, 8),
    clip(cf?.region, 64),
    clip(cf?.city, 64),
    Object.keys(headers).length ? JSON.stringify(headers) : null,
    token,
  );
  try {
    await insert.run();
  } catch (err) {
    // If the database is behind this code (a migration not applied yet), still record the hit
    // without the extra details rather than lose the only evidence of an open.
    const legacy = /no column named headers|no such column: headers/i.test(String(err));
    if (!legacy) await new Promise((r) => setTimeout(r, 200 + Math.random() * 300)); // transient: retry once
    await (legacy
      ? env.DB.prepare(
          `INSERT INTO hits (token, user_id, ts, ip, ua, asn, as_org, country, region, city)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM hits WHERE token = ?) < ${MAX_HITS_PER_EMAIL}`,
        ).bind(
          token,
          userId,
          Date.now(),
          req.headers.get("CF-Connecting-IP"),
          clip(req.headers.get("User-Agent"), 512),
          typeof cf?.asn === "number" ? cf.asn : null,
          clip(cf?.asOrganization, 128),
          clip(cf?.country, 8),
          clip(cf?.region, 64),
          clip(cf?.city, 64),
          token,
        )
      : insert
    ).run();
  }
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

app.post("/api/register", async (c) => {
  const body = await readJson(c);
  const invite = typeof body?.inviteCode === "string" ? body.inviteCode.trim() : "";
  if (c.env.INVITE_CODE && !(await safeEqual(invite, c.env.INVITE_CODE))) {
    return c.json({ error: "invalid_invite_code" }, 403);
  }
  const userId = newUserId();
  const apiKey = newApiKey();
  const mintKey = newMintKey();
  await c.env.DB.prepare(
    "INSERT INTO users (id, key_hash, mint_key, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(userId, await sha256Hex(apiKey), mintKey, Date.now())
    .run();
  return c.json<RegisterResponse>({ userId, apiKey, mintKey }, 201);
});

// Everything below requires `Authorization: Bearer <apiKey>`.
app.use("/api/*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const user = key ? await userForApiKey(c.env.DB, key) : null;
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
});

app.get("/api/me", (c) => c.json({ userId: c.get("user").id }));

/** Delete the account and everything recorded for it. */
app.delete("/api/me", async (c) => {
  const user = c.get("user");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM self_views WHERE token IN (SELECT token FROM messages WHERE user_id = ?)").bind(user.id),
    c.env.DB.prepare("DELETE FROM hits WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM messages WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  forgetCachedUser(user.id, user.key_hash);
  return c.body(null, 204);
});

/** Register (or update) a tracked email. Idempotent, so the extension can retry freely. */
app.put("/api/messages/:token", async (c) => {
  const user = c.get("user");
  const token = c.req.param("token");
  if (tokenUserId(token) !== user.id || (await authenticToken(c.env.DB, token)) !== user.id) {
    return c.json({ error: "invalid_token" }, 400);
  }
  const body = await readJson(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);

  const now = Date.now();
  const skew = clockSkew(body.clientNow, now);
  // Can't have been sent after we heard about it, nor more than a week before.
  const sentAt =
    typeof body.sentAt === "number" && Number.isFinite(body.sentAt)
      ? Math.min(Math.max(body.sentAt + skew, now - 7 * 86400_000), now)
      : now;

  await c.env.DB.prepare(
    `INSERT INTO messages (token, user_id, sender, subject, recipients, sent_at, thread_id,
                           message_id, sender_ip, sender_ua, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (token) DO UPDATE SET
       -- Later updates (Gmail's ids, backfilled recipients) only ever add information. When it was
       -- sent, and from which browser, are fixed by the first registration.
       sender = CASE WHEN excluded.sender = '' THEN messages.sender ELSE excluded.sender END,
       subject = CASE WHEN excluded.subject = '' THEN messages.subject ELSE excluded.subject END,
       recipients = CASE WHEN excluded.recipients = '[]' THEN messages.recipients ELSE excluded.recipients END,
       thread_id = COALESCE(excluded.thread_id, messages.thread_id),
       message_id = COALESCE(excluded.message_id, messages.message_id),
       updated_at = excluded.updated_at`,
  )
    .bind(
      token,
      user.id,
      clip(str(body.sender), 320) ?? "",
      clip(str(body.subject), 500) ?? "",
      JSON.stringify(recipients(body.recipients)),
      sentAt,
      clip(str(body.threadId), 64),
      clip(str(body.messageId), 64),
      c.req.header("CF-Connecting-IP") ?? null,
      clip(c.req.header("User-Agent"), 512),
      now,
      now,
    )
    .run();

  // Once per email: check whether the recipients sit behind a security gateway.
  const recips = recipients(body.recipients);
  if (recips.length) {
    c.executionCtx.waitUntil(
      checkGateway(c.env, token, recips.map((r) => r.email)).catch((err) => console.warn("gateway check failed", err)),
    );
  }
  return c.body(null, 204);
});

/** Swappable for tests. */
export const resolver: { resolveMx: MxResolver } = { resolveMx: dohResolveMx };

async function checkGateway(env: Env, token: string, emails: string[]): Promise<void> {
  const row = await env.DB.prepare("SELECT gateway_checked FROM messages WHERE token = ?")
    .bind(token)
    .first<{ gateway_checked: number }>();
  if (!row || row.gateway_checked) return;
  const { gateway, complete } = await detectGateway(emails, resolver.resolveMx);
  // If a DNS lookup failed, record what we found but try again on the next update.
  await env.DB.prepare("UPDATE messages SET gateway = COALESCE(?, gateway), gateway_checked = ? WHERE token = ?")
    .bind(gateway, complete ? 1 : 0, token)
    .run();
}

app.delete("/api/messages/:token", async (c) => {
  const user = c.get("user");
  const token = c.req.param("token");
  if (tokenUserId(token) !== user.id) return c.json({ error: "invalid_token" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM messages WHERE token = ? AND user_id = ?").bind(token, user.id),
    c.env.DB.prepare("DELETE FROM hits WHERE token = ? AND user_id = ?").bind(token, user.id),
    c.env.DB.prepare("DELETE FROM self_views WHERE token = ?").bind(token),
  ]);
  return c.body(null, 204);
});

/** Most recent tracked emails, newest first. */
app.get("/api/messages", async (c) => {
  const user = c.get("user");
  const limit = clampInt(c.req.query("limit"), 1, 100, 30);
  const before = clampInt(c.req.query("before"), 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const sender = c.req.query("sender");
  const rows = await c.env.DB.prepare(
    `SELECT * FROM messages WHERE user_id = ? AND sent_at < ? ${sender ? "AND sender = ?" : ""}
     ORDER BY sent_at DESC LIMIT ?`,
  )
    .bind(...(sender ? [user.id, before, sender, limit] : [user.id, before, limit]))
    .all<MessageRow>();
  const summaries = await buildSummaries(c.env.DB, rows.results, { now: Date.now(), settleMs: UI_SETTLE_MS });
  return c.json<ListResponse>({ messages: summaries.map(stripEvents) });
});

/** Summaries for specific emails, by pixel token and/or Gmail thread id. */
app.post("/api/messages/lookup", async (c) => {
  const user = c.get("user");
  const body = await readJson(c);
  const tokens = stringList(body?.tokens, 200).filter((t) => tokenUserId(t) === user.id);
  const threadIds = stringList(body?.threadIds, 200);
  const messageIds = stringList(body?.messageIds, 200);
  // Gmail thread/message ids are per mailbox, so match them only within the account asking.
  const sender = typeof body?.sender === "string" && body.sender ? body.sender : null;
  const scope = sender ? "AND sender = ?" : "";
  const lead = sender ? [user.id, sender] : [user.id];
  const found = await Promise.all([
    selectIn<MessageRow>(c.env.DB, (l) => `SELECT * FROM messages WHERE user_id = ? AND token IN (${l})`, tokens, [user.id]),
    selectIn<MessageRow>(c.env.DB, (l) => `SELECT * FROM messages WHERE user_id = ? ${scope} AND thread_id IN (${l})`, threadIds, lead),
    selectIn<MessageRow>(c.env.DB, (l) => `SELECT * FROM messages WHERE user_id = ? ${scope} AND message_id IN (${l})`, messageIds, lead),
  ]);
  const rows = [...new Map(found.flat().map((r) => [r.token, r])).values()];
  const summaries = await buildSummaries(c.env.DB, rows, { now: Date.now(), settleMs: UI_SETTLE_MS });
  return c.json<LookupResponse>({ messages: summaries.map(stripEvents) });
});

/** One email with its full, classified open history. */
app.get("/api/messages/:token", async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT * FROM messages WHERE token = ? AND user_id = ?")
    .bind(c.req.param("token"), user.id)
    .first<MessageRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const [detail] = await buildSummaries(c.env.DB, [row], {
    now: Date.now(),
    settleMs: UI_SETTLE_MS,
    withEvents: true,
  });
  return c.json(detail);
});

/** "The sender's own Gmail is displaying these pixels right now" — any hit around now is them. */
app.post("/api/self-views", async (c) => {
  const user = c.get("user");
  const body = await readJson(c);
  const tokens = [...new Set(stringList(body?.tokens, 50))].filter((t) => tokenUserId(t) === user.id);
  if (tokens.length) {
    const now = Date.now();
    // The beacon's own timestamp (it may be a retry), moved onto the server's clock. Trusted only
    // within a sane range.
    const at = typeof body?.at === "number" ? body.at + clockSkew(body.clientNow, now) : now;
    const ts = at >= now - 10 * 60_000 && at <= now + 5_000 ? at : now;
    await c.env.DB.batch(
      tokens.map((t) => c.env.DB.prepare("INSERT INTO self_views (token, ts) VALUES (?, ?)").bind(t, ts)),
    );
  }
  return c.body(null, 204);
});

/** New opens since `since`, for desktop notifications. Poll with the returned cursor. */
app.get("/api/events", async (c) => {
  const user = c.get("user");
  const now = Date.now();
  let upper = now - EVENTS_SETTLE_MS;
  const since = Math.max(
    clampInt(c.req.query("since"), 0, Number.MAX_SAFE_INTEGER, upper),
    now - EVENTS_MAX_LOOKBACK_MS,
  );
  if (since >= upper) return c.json<EventsResponse>({ events: [], cursor: Math.max(since, 0) });

  // Emails with new hits, oldest first. If there are more than a page, stop just before the page
  // boundary and let the next poll carry on from there, so nothing is skipped.
  const touched = await c.env.DB.prepare(
    `SELECT token, MIN(ts) AS first_ts FROM hits WHERE user_id = ? AND ts > ? AND ts <= ?
     GROUP BY token ORDER BY first_ts LIMIT ${EVENTS_PAGE + 1}`,
  )
    .bind(user.id, since, upper)
    .all<{ token: string; first_ts: number }>();
  let pageTokens = touched.results;
  if (pageTokens.length > EVENTS_PAGE) {
    upper = pageTokens[EVENTS_PAGE - 1]!.first_ts;
    pageTokens = pageTokens.filter((t) => t.first_ts <= upper);
  }

  // Emails registered after the previous poll ran (it happened at `since + settle`) whose opens
  // arrived before registration — e.g. the extension was offline when you sent. No earlier poll
  // could have reported those opens.
  const late = await c.env.DB.prepare(
    "SELECT token FROM messages WHERE user_id = ? AND created_at > ? AND created_at <= ? LIMIT 100",
  )
    .bind(user.id, since + EVENTS_SETTLE_MS, now)
    .all<{ token: string }>();
  const lateTokens = new Set(late.results.map((r) => r.token));

  const rows = await selectIn<MessageRow>(
    c.env.DB,
    (l) => `SELECT * FROM messages WHERE user_id = ? AND token IN (${l})`,
    [...new Set([...pageTokens.map((t) => t.token), ...lateTokens])],
    [user.id],
  );
  const details = await buildSummaries(c.env.DB, rows, { now, settleMs: EVENTS_SETTLE_MS, withEvents: true });

  const events: OpenNotification[] = [];
  for (const d of details) {
    let seenOpen = false;
    for (const e of d.events) {
      if (e.kind !== "open") continue;
      const first = !seenOpen;
      seenOpen = true;
      const fresh = e.at > since && e.at <= upper;
      const neverReported = lateTokens.has(d.token) && e.at <= since;
      if (fresh || neverReported) {
        events.push({
          token: d.token,
          sender: d.sender,
          subject: d.subject,
          recipients: d.recipients,
          threadId: d.threadId,
          at: e.at,
          client: e.client,
          detail: e.detail,
          first,
        });
      }
    }
  }
  events.sort((a, b) => a.at - b.at);
  return c.json<EventsResponse>({ events, cursor: upper });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal_error" }, 500);
});

// ---------------------------------------------------------------------------------------------
// Housekeeping (daily cron)
// ---------------------------------------------------------------------------------------------

export async function housekeeping(env: Env, now = Date.now()): Promise<void> {
  const orphanCutoff = now - 7 * 86400_000;
  const statements = [
    // Pixels minted but never registered (e.g. the email was discarded after an undo-send).
    env.DB.prepare(
      "DELETE FROM hits WHERE ts < ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.token = hits.token)",
    ).bind(orphanCutoff),
    env.DB.prepare(
      "DELETE FROM self_views WHERE ts < ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.token = self_views.token)",
    ).bind(orphanCutoff),
  ];
  const days = Number(env.RETENTION_DAYS ?? 0);
  if (Number.isFinite(days) && days > 0) {
    const cutoff = now - days * 86400_000;
    statements.push(
      env.DB.prepare(
        "DELETE FROM hits WHERE token IN (SELECT token FROM messages WHERE sent_at < ?)",
      ).bind(cutoff),
      env.DB.prepare(
        "DELETE FROM self_views WHERE token IN (SELECT token FROM messages WHERE sent_at < ?)",
      ).bind(cutoff),
      env.DB.prepare("DELETE FROM messages WHERE sent_at < ?").bind(cutoff),
    );
  }
  await env.DB.batch(statements);
}



// ---------------------------------------------------------------------------------------------
// Small validation helpers
// ---------------------------------------------------------------------------------------------

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * How far the client's clock is behind the server's, from the client's own "now" sent with the
 * request (network latency is negligible next to the windows this feeds). 0 if absent or absurd.
 */
function clockSkew(clientNow: unknown, now: number): number {
  if (typeof clientNow !== "number" || !Number.isFinite(clientNow)) return 0;
  const skew = now - clientNow;
  return Math.abs(skew) < 86400_000 ? skew : 0;
}

function clip(v: string | null | undefined, max: number): string | null {
  if (v == null) return null;
  return v.length > max ? v.slice(0, max) : v;
}

function stringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 128).slice(0, max);
}

function recipients(v: unknown): Recipient[] {
  if (!Array.isArray(v)) return [];
  const out: Recipient[] = [];
  for (const r of v.slice(0, 100)) {
    if (!r || typeof r !== "object") continue;
    const email = clip(str((r as Recipient).email)?.trim(), 320);
    if (!email) continue;
    const name = clip(str((r as Recipient).name)?.trim(), 200);
    out.push(name ? { name, email } : { email });
  }
  return out;
}

function clampInt(v: string | undefined, min: number, max: number, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
