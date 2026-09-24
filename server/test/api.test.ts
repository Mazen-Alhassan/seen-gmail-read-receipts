import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  EventsResponse,
  ListResponse,
  LookupResponse,
  MessageDetail,
  RegisterResponse,
} from "../../shared/api";
import { importMintKey, mintToken, newUserId, pixelPath } from "../../shared/token";
import { EVENTS_SETTLE_MS, housekeeping, resolver } from "../src/app";
import * as entry from "../src/index";
import worker from "../src/index";
import { UA } from "./fixtures";

const BASE = "https://seen.test";

// No real DNS from tests.
let mx: Record<string, string[]> = {};
beforeEach(() => {
  mx = {};
  resolver.resolveMx = async (domain) => mx[domain] ?? [];
});

async function api(
  path: string,
  opts: { method?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return exports.default.fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function register(): Promise<RegisterResponse> {
  const res = await api("/api/register", { method: "POST", body: { inviteCode: "test-invite" } });
  expect(res.status).toBe(201);
  return res.json();
}

async function tokenFor(user: RegisterResponse): Promise<string> {
  return mintToken(user.userId, await importMintKey(user.mintKey));
}

/** Request the pixel the way a mail client would, and wait for the hit to be recorded. */
async function fetchPixel(token: string, headers: Record<string, string>, method = "GET"): Promise<Response> {
  const req = new Request(`${BASE}${pixelPath(token)}`, { method, headers });
  const ctx = createExecutionContext();
  const res = await worker.fetch!(req as never, env as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const gmailOpen = { "User-Agent": UA.gmail, "CF-Connecting-IP": "66.249.84.10" };

async function hitCount(token: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM hits WHERE token = ?").bind(token).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Move a message's history into the past, so it's outside the settle windows. */
async function age(token: string, ms: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE hits SET ts = ts - ? WHERE token = ?").bind(ms, token),
    env.DB.prepare("UPDATE self_views SET ts = ts - ? WHERE token = ?").bind(ms, token),
    env.DB.prepare("UPDATE messages SET sent_at = sent_at - ? WHERE token = ?").bind(ms, token),
  ]);
}

async function putMessage(user: RegisterResponse, token: string, extra: Record<string, unknown> = {}) {
  const res = await api(`/api/messages/${token}`, {
    method: "PUT",
    key: user.apiKey,
    body: {
      sender: "me@example.com",
      subject: "Proposal",
      recipients: [{ name: "Alice", email: "alice@example.com" }],
      sentAt: Date.now(),
      ...extra,
    },
    headers: { "CF-Connecting-IP": "203.0.113.9", "User-Agent": UA.chromeMac },
  });
  expect(res.status).toBe(204);
}

describe("entry point", () => {
  it("exports only handlers (the runtime rejects any other named export)", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
  });
});

describe("pixel", () => {
  it("always returns an uncacheable 1×1 GIF, even for junk tokens", async () => {
    const res = await exports.default.fetch(`${BASE}/i/nonsense.gif`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/gif");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe("GIF89a");
  });

  it("records authentic tokens and ignores forged ones", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await fetchPixel(token, gmailOpen);
    expect(await hitCount(token)).toBe(1);

    // Right user id, wrong key → can't forge.
    const forged = await mintToken(user.userId, await importMintKey("A".repeat(43)));
    await fetchPixel(forged, gmailOpen);
    expect(await hitCount(forged)).toBe(0);

    // Unknown user.
    const stranger = await mintToken(newUserId(), await importMintKey("B".repeat(43)));
    await fetchPixel(stranger, gmailOpen);
    expect(await hitCount(stranger)).toBe(0);
  });

  it("records hits that arrive before the email is registered", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await fetchPixel(token, gmailOpen);
    await putMessage(user, token, { sentAt: Date.now() - 60_000 }); // sent a minute ago, registered late
    await age(token, 5 * 60_000);
    const res = await api(`/api/messages/${token}`, { key: user.apiKey });
    expect(((await res.json()) as MessageDetail).opens).toBe(1);
  });

  it("does not record HEAD requests", async () => {
    const user = await register();
    const token = await tokenFor(user);
    const res = await fetchPixel(token, gmailOpen, "HEAD");
    expect(res.status).toBe(200);
    expect(await hitCount(token)).toBe(0);
  });
});

describe("accounts", () => {
  it("requires the invite code", async () => {
    expect((await api("/api/register", { method: "POST", body: { inviteCode: "wrong" } })).status).toBe(403);
    expect((await api("/api/register", { method: "POST", body: {} })).status).toBe(403);
  });

  it("authenticates with the API key", async () => {
    const user = await register();
    const me = await api("/api/me", { key: user.apiKey });
    expect(await me.json()).toEqual({ userId: user.userId });
    expect((await api("/api/me")).status).toBe(401);
    expect((await api("/api/me", { key: "nope" })).status).toBe(401);
  });

  it("lets the extension read /health and /api/register cross-origin", async () => {
    const origin = { Origin: "chrome-extension://abcdefghijklmnop" };
    const health = await exports.default.fetch(`${BASE}/health`, { headers: origin });
    expect(health.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const reg = await api("/api/register", { method: "POST", body: { inviteCode: "test-invite" }, headers: origin });
    expect(reg.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers CORS preflight for the extension", async () => {
    const res = await exports.default.fetch(`${BASE}/api/messages`, {
      method: "OPTIONS",
      headers: {
        Origin: "chrome-extension://abcdefghijklmnop",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("deletes the account and all its data", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token);
    await fetchPixel(token, gmailOpen);
    expect((await api("/api/me", { method: "DELETE", key: user.apiKey })).status).toBe(204);
    expect(await hitCount(token)).toBe(0);
    expect((await api("/api/me", { key: user.apiKey })).status).toBe(401);
  });
});

describe("messages", () => {
  it("only accepts the caller's own authentic tokens", async () => {
    const alice = await register();
    const bob = await register();
    const bobsToken = await tokenFor(bob);
    const res = await api(`/api/messages/${bobsToken}`, {
      method: "PUT",
      key: alice.apiKey,
      body: { sender: "a", subject: "b", recipients: [] },
    });
    expect(res.status).toBe(400);
  });

  it("tracks the full lifecycle: sent → opened, with the sender's own views ignored", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token, { threadId: "18f00000000000a1" });

    // The sender's Gmail renders the sent message (proxy fetch + beacon)…
    await fetchPixel(token, gmailOpen);
    await api("/api/self-views", { method: "POST", key: user.apiKey, body: { tokens: [token] } });
    await age(token, 10 * 60_000);

    let detail = (await (await api(`/api/messages/${token}`, { key: user.apiKey })).json()) as MessageDetail;
    expect(detail.status).toBe("sent");
    expect(detail.events.map((e) => e.kind)).toEqual(["self"]);

    // …then the recipient opens it.
    await fetchPixel(token, gmailOpen);
    await age(token, 60_000);
    detail = (await (await api(`/api/messages/${token}`, { key: user.apiKey })).json()) as MessageDetail;
    expect(detail).toMatchObject({ status: "opened", opens: 1, lastClient: "gmail", subject: "Proposal" });
    expect(detail.recipients).toEqual([{ name: "Alice", email: "alice@example.com" }]);

    // Lookup by Gmail thread id (thread list) and by token (message view).
    const byThread = (await (
      await api("/api/messages/lookup", { method: "POST", key: user.apiKey, body: { threadIds: ["18f00000000000a1"] } })
    ).json()) as LookupResponse;
    expect(byThread.messages.map((m) => m.token)).toEqual([token]);
    expect(byThread.messages[0]).not.toHaveProperty("events");

    await putMessage(user, token, { messageId: "18f00000000000b2" });
    const byMessage = (await (
      await api("/api/messages/lookup", { method: "POST", key: user.apiKey, body: { messageIds: ["18f00000000000b2"], tokens: [token] } })
    ).json()) as LookupResponse;
    expect(byMessage.messages.map((m) => m.token)).toEqual([token]);
  });

  it("keeps thread/message ids when a later update omits them", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token, { threadId: "t1", messageId: "m1" });
    await putMessage(user, token);
    const d = (await (await api(`/api/messages/${token}`, { key: user.apiKey })).json()) as MessageDetail;
    expect(d).toMatchObject({ threadId: "t1", messageId: "m1" });
  });

  it("never erases known recipients or subject with an emptier update", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token, { recipients: [], subject: "" });
    await putMessage(user, token); // backfill: now we know them
    await putMessage(user, token, { recipients: [], subject: "" }); // a late, emptier retry
    const d = (await (await api(`/api/messages/${token}`, { key: user.apiKey })).json()) as MessageDetail;
    expect(d.subject).toBe("Proposal");
    expect(d.recipients).toEqual([{ name: "Alice", email: "alice@example.com" }]);
  });

  it("does not show a hit that may still be the sender until it settles", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token);
    await fetchPixel(token, gmailOpen);
    const d = (await (await api(`/api/messages/${token}`, { key: user.apiKey })).json()) as MessageDetail;
    expect(d.status).toBe("sent");
  });

  it("lists newest first, filtered by sender", async () => {
    const user = await register();
    const t1 = await tokenFor(user);
    const t2 = await tokenFor(user);
    const t3 = await tokenFor(user);
    await putMessage(user, t1, { sentAt: Date.now() - 3_000 });
    await putMessage(user, t2, { sentAt: Date.now() - 2_000 });
    await putMessage(user, t3, { sentAt: Date.now() - 1_000, sender: "other@example.com" });
    const all = (await (await api("/api/messages", { key: user.apiKey })).json()) as ListResponse;
    expect(all.messages.map((m) => m.token)).toEqual([t3, t2, t1]);
    const mine = (await (
      await api("/api/messages?sender=me%40example.com&limit=1", { key: user.apiKey })
    ).json()) as ListResponse;
    expect(mine.messages.map((m) => m.token)).toEqual([t2]);
  });

  it("deletes a message and its history", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token);
    await fetchPixel(token, gmailOpen);
    expect((await api(`/api/messages/${token}`, { method: "DELETE", key: user.apiKey })).status).toBe(204);
    expect((await api(`/api/messages/${token}`, { key: user.apiKey })).status).toBe(404);
    expect(await hitCount(token)).toBe(0);
  });
});

describe("security gateways", () => {
  it("flags emails whose recipients are behind a gateway, once", async () => {
    mx["bigcorp.example"] = ["mx0a-0011.pphosted.com."];
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token, { recipients: [{ email: "cfo@bigcorp.example" }] });

    let row: { gateway: string | null; gateway_checked: number } | null = null;
    for (let i = 0; i < 50 && !row?.gateway_checked; i++) {
      await new Promise((r) => setTimeout(r, 10));
      row = await env.DB.prepare("SELECT gateway, gateway_checked FROM messages WHERE token = ?").bind(token).first();
    }
    expect(row).toEqual({ gateway: "Proofpoint", gateway_checked: 1 });
  });
});

describe("notifications edge cases", () => {
  it("reports opens of an email registered late (e.g. sent while offline), once", async () => {
    const user = await register();
    const token = await tokenFor(user);
    const poll = async (since: number) =>
      (await (await api(`/api/events?since=${since}`, { key: user.apiKey })).json()) as EventsResponse;

    // A poll ran before the email reached the server…
    const before = await poll(Date.now() - 10 * 60_000);
    // …the open happened while registration was still queued…
    await env.DB.prepare("INSERT INTO hits (token, user_id, ts, ip, ua, asn) VALUES (?, ?, ?, '66.249.84.1', ?, 15169)")
      .bind(token, user.userId, before.cursor - 60_000, UA.gmail)
      .run();
    // …and registration landed after that poll.
    await env.DB.prepare(
      `INSERT INTO messages (token, user_id, sender, subject, recipients, sent_at, created_at, updated_at)
       VALUES (?, ?, 'me@example.com', 'Offline', '[]', ?, ?, ?)`,
    )
      .bind(token, user.userId, before.cursor - 5 * 60_000, Date.now(), Date.now())
      .run();
    const now = await poll(before.cursor - 31_000); // as if the previous poll ran 31s ago
    expect(now.events.map((e) => e.subject)).toEqual(["Offline"]);
    expect((await poll(now.cursor)).events).toEqual([]);
  });

  it("keeps when an email was sent, whatever later updates say", async () => {
    const user = await register();
    const token = await tokenFor(user);
    const sentAt = Date.now() - 60_000;
    await putMessage(user, token, { sentAt });
    await putMessage(user, token, { sentAt: Date.now(), messageId: "m-1", sender: "" });
    const row = await env.DB.prepare("SELECT sent_at, sender, message_id FROM messages WHERE token = ?")
      .bind(token)
      .first<{ sent_at: number; sender: string; message_id: string }>();
    expect(row).toEqual({ sent_at: sentAt, sender: "me@example.com", message_id: "m-1" });
  });

  it("never records a send time in the future", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token, { sentAt: Date.now() + 3600_000 });
    const row = await env.DB.prepare("SELECT sent_at FROM messages WHERE token = ?").bind(token).first<{ sent_at: number }>();
    expect(row!.sent_at).toBeLessThanOrEqual(Date.now());
  });

  it("matches thread ids only within the Gmail account asking", async () => {
    const user = await register();
    const [a, b] = [await tokenFor(user), await tokenFor(user)];
    await putMessage(user, a, { threadId: "same-id", sender: "one@gmail.com" });
    await putMessage(user, b, { threadId: "same-id", sender: "two@gmail.com" });
    const res = (await (
      await api("/api/messages/lookup", { method: "POST", key: user.apiKey, body: { threadIds: ["same-id"], sender: "two@gmail.com" } })
    ).json()) as LookupResponse;
    expect(res.messages.map((m) => m.token)).toEqual([b]);
  });

  it("still records hits if the database is missing the newest column (migration not applied)", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await env.DB.prepare("ALTER TABLE hits RENAME COLUMN headers TO headers_tmp").run();
    try {
      await fetchPixel(token, gmailOpen);
      expect(await hitCount(token)).toBe(1);
    } finally {
      await env.DB.prepare("ALTER TABLE hits RENAME COLUMN headers_tmp TO headers").run();
    }
  });

  it("keeps extra request details with each hit for future re-analysis", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await fetchPixel(token, { ...gmailOpen, Accept: "image/webp,*/*", Referer: "https://mail.google.com/" });
    const row = await env.DB.prepare("SELECT headers FROM hits WHERE token = ?").bind(token).first<{ headers: string }>();
    expect(JSON.parse(row!.headers)).toMatchObject({ accept: "image/webp,*/*", referer: "https://mail.google.com/" });
  });
});

describe("clock skew", () => {
  it("moves the sender's timestamps onto the server's clock", async () => {
    const user = await register();
    const token = await tokenFor(user);
    const skew = 3 * 60_000; // the sender's computer is 3 minutes slow
    const clientNow = Date.now() - skew;
    await putMessage(user, token, { sentAt: clientNow - 1_000, clientNow });
    const row = await env.DB.prepare("SELECT sent_at FROM messages WHERE token = ?").bind(token).first<{ sent_at: number }>();
    expect(Math.abs(row!.sent_at - (Date.now() - 1_000))).toBeLessThan(2_000);

    await api("/api/self-views", { method: "POST", key: user.apiKey, body: { tokens: [token], at: clientNow, clientNow } });
    const view = await env.DB.prepare("SELECT ts FROM self_views WHERE token = ?").bind(token).first<{ ts: number }>();
    expect(Math.abs(view!.ts - Date.now())).toBeLessThan(2_000);
  });
});

describe("abuse", () => {
  it("caps how many image loads one email can record", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await env.DB.batch(
      Array.from({ length: 300 }, (_, i) =>
        env.DB.prepare("INSERT INTO hits (token, user_id, ts) VALUES (?, ?, ?)").bind(token, user.userId, i),
      ),
    );
    await fetchPixel(token, gmailOpen);
    expect(await hitCount(token)).toBe(300);
  });
});

describe("self-views", () => {
  it("uses the client's timestamp when plausible, so retried beacons still line up", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token);
    const at = Date.now() - 5 * 60_000;
    await api("/api/self-views", { method: "POST", key: user.apiKey, body: { tokens: [token], at } });
    await api("/api/self-views", { method: "POST", key: user.apiKey, body: { tokens: [token], at: 1 } });
    const rows = await env.DB.prepare("SELECT ts FROM self_views WHERE token = ? ORDER BY ts").bind(token).all<{ ts: number }>();
    expect(rows.results[0]!.ts).toBe(at);
    expect(rows.results[1]!.ts).toBeGreaterThan(Date.now() - 10_000); // implausible → server time
  });

  it("ignores tokens that aren't the caller's", async () => {
    const alice = await register();
    const bob = await register();
    const bobsToken = await tokenFor(bob);
    await api("/api/self-views", { method: "POST", key: alice.apiKey, body: { tokens: [bobsToken] } });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM self_views WHERE token = ?").bind(bobsToken).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("events", () => {
  it("reports each settled open once, marking the first", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token, { threadId: "t-events" });
    const start = Date.now() - 60 * 60_000;

    const insert = (ts: number, ua = UA.gmail) =>
      env.DB.prepare("INSERT INTO hits (token, user_id, ts, ip, ua, asn) VALUES (?, ?, ?, '66.249.84.1', ?, 15169)")
        .bind(token, user.userId, ts, ua)
        .run();
    await env.DB.prepare("UPDATE messages SET sent_at = ? WHERE token = ?").bind(start, token).run();
    await insert(start + 10 * 60_000); // first open
    await insert(start + 10 * 60_000 + 5_000); // repeat — no event
    await insert(start + 40 * 60_000); // second open

    const poll = async (since: number) =>
      (await (await api(`/api/events?since=${since}`, { key: user.apiKey })).json()) as EventsResponse;

    const first = await poll(start);
    expect(first.events.map((e) => [e.at - start, e.first])).toEqual([
      [10 * 60_000, true],
      [40 * 60_000, false],
    ]);
    expect(first.events[0]).toMatchObject({
      sender: "me@example.com",
      subject: "Proposal",
      threadId: "t-events",
      client: "gmail",
    });

    // Polling again from the cursor yields nothing new…
    expect((await poll(first.cursor)).events).toEqual([]);

    // …and a brand-new hit isn't reported until it has settled.
    await insert(Date.now() - 1_000);
    expect((await poll(first.cursor)).events).toEqual([]);
    expect(first.cursor).toBeLessThanOrEqual(Date.now() - EVENTS_SETTLE_MS);
  });
});

describe("housekeeping", () => {
  it("drops week-old hits for emails that were never registered", async () => {
    const user = await register();
    const registered = await tokenFor(user);
    const orphan = await tokenFor(user);
    await putMessage(user, registered);
    const old = Date.now() - 8 * 86400_000;
    for (const t of [registered, orphan]) {
      await env.DB.prepare("INSERT INTO hits (token, user_id, ts) VALUES (?, ?, ?)").bind(t, user.userId, old).run();
    }
    await housekeeping(env);
    expect(await hitCount(registered)).toBe(1);
    expect(await hitCount(orphan)).toBe(0);
  });

  it("applies the retention period", async () => {
    const user = await register();
    const token = await tokenFor(user);
    await putMessage(user, token);
    await env.DB.prepare("UPDATE messages SET sent_at = ? WHERE token = ?").bind(Date.now() - 400 * 86400_000, token).run();
    await housekeeping({ ...env, RETENTION_DAYS: "365" });
    expect((await api(`/api/messages/${token}`, { key: user.apiKey })).status).toBe(404);
  });
});
