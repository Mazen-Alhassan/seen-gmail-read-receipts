// End-to-end smoke test against a running Seen server (local `wrangler dev` or deployed).
// Plays the part of the extension and of recipients' mail clients, then cleans up after itself.
//
//   node scripts/smoke.mjs https://seen.example.com <invite-code>
//
// Needs Node 22.18+ (imports the shared TypeScript token code directly).
import { importMintKey, mintToken, pixelPath } from "../shared/token.ts";

const [base = "http://127.0.0.1:8787", invite = ""] = process.argv.slice(2);
const GMAIL_PROXY = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";
const APPLE_MPP = "Mozilla/5.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function api(path, { method = "GET", key, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function pixel(token, ua) {
  const res = await fetch(`${base}${pixelPath(token)}`, { headers: { "User-Agent": ua } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes };
}

console.log(`Smoke-testing ${base}\n`);

const health = await api("/health");
check("server is up", health.status === 200 && health.json?.ok === true);

const bad = await api("/api/register", { method: "POST", body: { inviteCode: "definitely-wrong" } });
check("wrong invite code is refused", bad.status === 403, `HTTP ${bad.status}`);

const reg = await api("/api/register", { method: "POST", body: { inviteCode: invite } });
check("extension can register", reg.status === 201, `HTTP ${reg.status}`);
if (reg.status !== 201) process.exit(1);
const { apiKey, userId, mintKey } = reg.json;
const key = await importMintKey(mintKey);
const start = Date.now();

try {
  // 1. An email sent and then opened in Gmail.
  const opened = await mintToken(userId, key);
  const put = await api(`/api/messages/${opened}`, {
    method: "PUT",
    key: apiKey,
    body: { sender: "me@example.com", subject: "Smoke test", recipients: [{ name: "Alice", email: "alice@example.com" }], sentAt: start - 60_000 },
  });
  check("email registers", put.status === 204, `HTTP ${put.status}`);

  const { res, bytes } = await pixel(opened, GMAIL_PROXY);
  check("pixel is a GIF", res.status === 200 && res.headers.get("content-type") === "image/gif" && bytes[0] === 0x47);
  check("pixel is uncacheable", /no-store/.test(res.headers.get("cache-control") ?? ""));

  // 2. An email the sender looks at in their own Gmail (beacon + proxied fetch).
  const selfViewed = await mintToken(userId, key);
  await api(`/api/messages/${selfViewed}`, { method: "PUT", key: apiKey, body: { sender: "me@example.com", subject: "Self view", recipients: [{ email: "bob@example.com" }], sentAt: start - 60_000 } });
  await api("/api/self-views", { method: "POST", key: apiKey, body: { tokens: [selfViewed] } });
  await pixel(selfViewed, GMAIL_PROXY);

  // 3. An email delivered to Apple Mail with Privacy Protection.
  const apple = await mintToken(userId, key);
  await api(`/api/messages/${apple}`, { method: "PUT", key: apiKey, body: { sender: "me@example.com", subject: "Apple", recipients: [{ email: "carol@icloud.com" }], sentAt: start - 60_000 } });
  await pixel(apple, APPLE_MPP);

  // 4. A forged pixel must never be recorded.
  const forged = opened.slice(0, 26) + (opened[26] === "A" ? "B" : "A") + opened.slice(27);
  await pixel(forged, GMAIL_PROXY);

  console.log("\n…waiting 10s for hits to settle (in case a 'that was me' beacon is in flight)");
  await sleep(10_000);

  const detail = await api(`/api/messages/${opened}`, { key: apiKey });
  check("Gmail open is counted", detail.json?.status === "opened" && detail.json?.opens === 1, JSON.stringify({ status: detail.json?.status, opens: detail.json?.opens }));
  check("open is attributed to Gmail", detail.json?.lastClient === "gmail");

  const self = await api(`/api/messages/${selfViewed}`, { key: apiKey });
  check("sender's own view is ignored", self.json?.status === "sent" && self.json?.events?.[0]?.kind === "self");

  // (Only Apple's own relay networks count as Apple's privacy proxy — a script can't come from
  // there, so from here it just has to not count as an open.)
  const mpp = await api(`/api/messages/${apple}`, { key: apiKey });
  check("automatic prefetch isn't counted as an open", mpp.json?.status !== "opened" && mpp.json?.opens === 0, mpp.json?.status);

  const list = await api("/api/messages?limit=10", { key: apiKey });
  check("list shows all three", list.json?.messages?.length === 3);

  console.log("…waiting 22s more for the notification window (30s settle)");
  await sleep(22_000);
  const events = await api(`/api/events?since=${start - 5_000}`, { key: apiKey });
  const evs = events.json?.events ?? [];
  check("exactly one open notification", evs.length === 1 && evs[0].token === opened && evs[0].first === true, `${evs.length} event(s)`);
} finally {
  const del = await api("/api/me", { method: "DELETE", key: apiKey });
  check("test account cleaned up", del.status === 204);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
