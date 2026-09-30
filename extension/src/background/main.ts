// InboxSDK's page-world injector must be registered at the top level of the service worker.
import "@inboxsdk/core/background.js";

import type {
  EventsResponse,
  ListResponse,
  LookupResponse,
  MessageDetail,
  OpenNotification,
  RegisterResponse,
} from "../../../shared/api";
import { importMintKey, mintToken, tokenPrefix } from "../../../shared/token";
import {
  decodeConnectionCode,
  encodeConnectionCode,
  getConnection,
  getPrefs,
  normaliseServerUrl,
  setConnection,
  setPrefs,
  type Connection,
} from "../lib/config";
import { gmailThreadUrl, notificationTitle } from "../lib/format";
import { wrapReply, type Push, type Request, type Responses, type State } from "../lib/protocol";
import { ApiError, call, serverNow, setUnauthorizedHandler } from "./api";
import { showCountOnIcon } from "./badge";
import * as outbox from "./queue";
import { refreshIdleGmailTabs } from "./tabs";

const TICK_ALARM = "seen-tick";
const HANDLED = new Set<Request["type"]>([
  "state",
  "mintTokens",
  "register",
  "untrack",
  "selfViews",
  "lookup",
  "detail",
  "list",
  "connect",
  "disconnect",
  "setPrefs",
  "pollNow",
  "markSeen",
  "openOptions",
  "exportConnection",
  "importConnection",
  "followUp",
]);

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(TICK_ALARM))) {
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.1 });
  }
}

/**
 * Stop the sender's own Gmail from loading their own pixels at all — whether directly or through
 * Google's image proxy, whose URLs end in "#https://<server>/i/<token>.gif". Matching on the
 * user's token prefix means other people's pixels (emails you receive) are never touched.
 */
const SELF_BLOCK_RULE_ID = 1;
async function syncSelfBlockRule(): Promise<void> {
  const conn = await getConnection();
  const addRules: chrome.declarativeNetRequest.Rule[] = conn
    ? [
        {
          id: SELF_BLOCK_RULE_ID,
          priority: 1,
          action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
          condition: {
            urlFilter: `${new URL(conn.serverUrl).host}/i/${tokenPrefix(conn.userId)}`,
            isUrlFilterCaseSensitive: true,
            initiatorDomains: ["mail.google.com"],
            resourceTypes: [chrome.declarativeNetRequest.ResourceType.IMAGE],
          },
        },
      ]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [SELF_BLOCK_RULE_ID], addRules });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureAlarm();
  await syncSelfBlockRule();
  await updateBadge();
  if (reason === chrome.runtime.OnInstalledReason.INSTALL || reason === chrome.runtime.OnInstalledReason.UPDATE) {
    await refreshIdleGmailTabs();
  }
  if (reason === chrome.runtime.OnInstalledReason.INSTALL && !(await getConnection())) {
    await chrome.runtime.openOptionsPage();
  }
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void syncSelfBlockRule();
  void updateBadge();
});
void ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) void tick();
});

/** How often to check for opens while no Gmail tab is open (every tick, i.e. 30s, when one is). */
const IDLE_POLL_MS = 5 * 60_000;
const GMAIL_TABS = "https://mail.google.com/mail/*";

let ticking: Promise<void> | null = null;
/** Deliver queued writes, then check for new opens. Coalesces overlapping calls. */
function tick(force = false): Promise<void> {
  ticking ??= (async () => {
    try {
      const conn = await getConnection();
      if (!conn || (await authLost())) return;
      await outbox.flush(conn);
      // Poll often while Gmail is open; otherwise every few minutes (still notifies, costs less).
      const { lastPollAt = 0 } = await chrome.storage.session.get("lastPollAt");
      const gmailOpen = (await chrome.tabs.query({ url: GMAIL_TABS })).length > 0;
      if (!force && !gmailOpen && Date.now() - (lastPollAt as number) < IDLE_POLL_MS) return;
      await chrome.storage.session.set({ lastPollAt: Date.now() });
      await poll(conn);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 0)) console.warn("[Seen] tick failed", err);
    } finally {
      ticking = null;
    }
  })();
  return ticking;
}

// ---------------------------------------------------------------------------------------------
// Opens → notifications
// ---------------------------------------------------------------------------------------------

async function poll(conn: Connection): Promise<void> {
  const { eventsCursor } = await chrome.storage.local.get("eventsCursor");
  // First poll after connecting has no cursor: the server answers with "now", so we never
  // replay old history as fresh notifications.
  const qs = typeof eventsCursor === "number" ? `?since=${eventsCursor}` : "";
  const res = await call<EventsResponse>(conn, "GET", `/api/events${qs}`);
  await chrome.storage.local.set({ eventsCursor: res.cursor });
  if (res.events.length === 0) return;

  const prefs = await getPrefs();
  const toNotify = res.events.filter((e) => prefs.notify === "every" || (prefs.notify === "first" && e.first));
  if (toNotify.length > 3) {
    // Coming back after a while: one summary instead of a stack of notifications.
    await notifySummary(toNotify);
  } else {
    for (const e of toNotify) await notify(e);
  }
  const { unseenOpens = 0 } = await chrome.storage.local.get("unseenOpens");
  const unseen = (unseenOpens as number) + res.events.filter((e) => e.first).length;
  await chrome.storage.local.set({ unseenOpens: unseen });
  await updateBadge(unseen);
  await broadcast({ type: "opened", events: res.events });
}

async function notify(e: OpenNotification): Promise<void> {
  const id = `seen:${e.token}:${e.at}`;
  await chrome.storage.session.set({ [id]: gmailThreadUrl(e.sender, e.threadId) });
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: notificationTitle(e),
    message: e.subject || "(no subject)",
    contextMessage: e.detail,
    priority: 0,
  });
}

async function notifySummary(events: OpenNotification[]): Promise<void> {
  const id = `seen:summary:${Date.now()}`;
  const emails = new Set(events.map((e) => e.token)).size;
  await chrome.storage.session.set({ [id]: gmailThreadUrl(events[0]!.sender, null) });
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: `${emails} of your emails were opened`,
    message: [...new Set(events.map((e) => e.subject || "(no subject)"))].slice(0, 3).join(" · "),
    contextMessage: "Click the Seen icon to see which ones",
    priority: 0,
  });
}

chrome.notifications.onClicked.addListener(async (id) => {
  const { [id]: url } = await chrome.storage.session.get(id);
  if (typeof url === "string") await chrome.tabs.create({ url });
  await chrome.notifications.clear(id);
});

/**
 * Toolbar icon: a small red count (bottom-left) of emails opened since you last looked, or an
 * orange "!" while Seen isn't connected, so that can't go unnoticed.
 */
async function updateBadge(count?: number): Promise<void> {
  const lost = await authLost();
  if (!(await getConnection()) || lost) {
    await showCountOnIcon(0).catch(() => undefined);
    await chrome.action.setBadgeBackgroundColor({ color: "#b06000" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({
      title: lost ? "Seen: your server no longer recognises this browser — click to reconnect" : "Seen isn't connected: click to set up",
    });
    return;
  }
  if (count === undefined) {
    const { unseenOpens = 0 } = await chrome.storage.local.get("unseenOpens");
    count = unseenOpens as number;
  }
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({
    title: count > 0 ? `Seen: ${count} email${count === 1 ? "" : "s"} opened since you last looked` : "Seen",
  });
  await showCountOnIcon(count).catch((err) => console.warn("[Seen] couldn't draw the icon count", err));
}

// If the server stops accepting our key (the account was deleted, e.g. from another browser that
// shared it), stop pretending to track: flag it everywhere until you reconnect.
async function authLost(): Promise<boolean> {
  const { authLost: lost } = await chrome.storage.local.get("authLost");
  return lost === true;
}
setUnauthorizedHandler(() => {
  void (async () => {
    if (await authLost()) return;
    await chrome.storage.local.set({ authLost: true });
    await updateBadge();
    await broadcast({ type: "stateChanged" });
  })();
});

/**
 * Show the thread, so the follow-up sitting on the clipboard can be pasted into it.
 *
 * Reuses a tab that's already on the thread, then any Gmail tab, and only opens a new one as a
 * last resort — nobody wants a fresh tab every time they nudge someone.
 */
async function openFollowUp(sender: string, threadId: string, body: string, copied: boolean): Promise<void> {
  const open = (await chrome.tabs.query({ url: GMAIL_TABS })).filter((t) => t.id !== undefined);
  const onThread = open.find((t) => (t.url ?? "").includes(threadId));
  const reuse = onThread ?? open[0];

  let tabId: number;
  if (reuse?.id !== undefined) {
    tabId = reuse.id;
    if (!onThread) await chrome.tabs.update(tabId, { url: gmailThreadUrl(sender, threadId) });
    await chrome.tabs.update(tabId, { active: true });
    if (reuse.windowId !== undefined) {
      await chrome.windows.update(reuse.windowId, { focused: true }).catch(() => undefined);
    }
  } else {
    const created = await chrome.tabs.create({ url: gmailThreadUrl(sender, threadId) });
    if (created.id === undefined) throw new Error("Couldn't open Gmail");
    tabId = created.id;
  }

  await waitForLoad(tabId);
  await deliver(tabId, { type: "followUp", body, copied });
}

/** A tab we just navigated is still running the old page for a moment, which would swallow the push. */
async function waitForLoad(tabId: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === "complete") return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Gmail's content script may still be starting up, so keep offering until someone takes it. */
async function deliver(tabId: number, push: Push): Promise<void> {
  for (const wait of [0, 400, 800, 1_500, 2_500, 4_000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      await chrome.tabs.sendMessage(tabId, push);
      return;
    } catch {
      /* not listening yet */
    }
  }
  // The thread is open and the text is already copied, so a silent miss here costs nothing.
}

async function broadcast(push: Push): Promise<void> {
  const tabs = await chrome.tabs.query({ url: GMAIL_TABS });
  await Promise.all(
    tabs.map((t) => (t.id === undefined ? null : chrome.tabs.sendMessage(t.id, push).catch(() => null))),
  );
}

// ---------------------------------------------------------------------------------------------
// Requests from the content script, popup and options page
// ---------------------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Leave anything that isn't ours (e.g. InboxSDK's own messages) to its listener.
  if (!msg || typeof msg !== "object" || !HANDLED.has((msg as Request).type)) return false;
  void wrapReply(handle(msg as Request)).then(sendResponse);
  return true;
});

async function requireConnection(): Promise<Connection> {
  const conn = await getConnection();
  if (!conn) throw new Error("Seen isn't connected to a server yet");
  return conn;
}

let mintKeyCache: { raw: string; key: CryptoKey } | null = null;
async function mintKeyFor(conn: Connection): Promise<CryptoKey> {
  if (mintKeyCache?.raw !== conn.mintKey) {
    mintKeyCache = { raw: conn.mintKey, key: await importMintKey(conn.mintKey) };
  }
  return mintKeyCache.key;
}

async function state(): Promise<State> {
  const conn = await getConnection();
  const lost = await authLost();
  return {
    connected: !!conn && !lost,
    problem: conn && lost ? "auth" : null,
    serverUrl: conn?.serverUrl ?? null,
    serverHost: conn ? new URL(conn.serverUrl).host : null,
    userId: conn?.userId ?? null,
    prefs: await getPrefs(),
    pending: await outbox.pendingCount(),
  };
}

async function handle(req: Request): Promise<Responses[Request["type"]]> {
  switch (req.type) {
    case "state":
      return state();

    case "mintTokens": {
      const conn = await requireConnection();
      const key = await mintKeyFor(conn);
      const count = Math.min(Math.max(req.count, 1), 20);
      return { tokens: await Promise.all(Array.from({ length: count }, () => mintToken(conn.userId, key))) };
    }

    case "register": {
      // sentAt stays on this computer's clock; the server corrects it using clientNow.
      await outbox.enqueue({ kind: "put", token: req.token, message: { ...req.message } });
      const conn = await getConnection();
      if (conn) await outbox.flush(conn).catch(() => undefined);
      return { ok: true };
    }

    case "untrack": {
      await outbox.enqueue({ kind: "delete", token: req.token });
      const conn = await getConnection();
      if (conn) await outbox.flush(conn).catch(() => undefined);
      return { ok: true };
    }

    case "selfViews": {
      const conn = await getConnection();
      if (!conn || req.tokens.length === 0) return { ok: true };
      const body = { tokens: req.tokens.slice(0, 50), at: Date.now() };
      try {
        await call(conn, "POST", "/api/self-views", { ...body, clientNow: Date.now() });
      } catch {
        // One quick retry: the beacon carries its own timestamp, so a late arrival still counts.
        setTimeout(
          () => void call(conn, "POST", "/api/self-views", { ...body, clientNow: Date.now() }).catch(() => undefined),
          3_000,
        );
      }
      return { ok: true };
    }

    case "lookup": {
      const conn = await requireConnection();
      const tokens = req.tokens ?? [];
      const threadIds = req.threadIds ?? [];
      const messageIds = req.messageIds ?? [];
      if (!tokens.length && !threadIds.length && !messageIds.length) return { messages: [] };
      return call<LookupResponse>(conn, "POST", "/api/messages/lookup", { tokens, threadIds, messageIds, sender: req.sender });
    }

    case "detail": {
      const conn = await requireConnection();
      try {
        return { message: await call<MessageDetail>(conn, "GET", `/api/messages/${req.token}`) };
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return { message: null };
        throw err;
      }
    }

    case "list": {
      const conn = await requireConnection();
      const limit = Math.min(Math.max(req.limit ?? 30, 1), 100);
      return call<ListResponse>(conn, "GET", `/api/messages?limit=${limit}`);
    }

    case "connect":
      return connect(req.serverUrl, req.inviteCode);

    case "disconnect": {
      const conn = await getConnection();
      if (conn && req.deleteData && !(await authLost())) {
        try {
          await call(conn, "DELETE", "/api/me");
        } catch (err) {
          // Don't pretend it's gone: stay connected so you can try again.
          return { ok: false, error: `Couldn't delete your data (${err instanceof Error ? err.message : err}). Nothing was changed; try again.` };
        }
      }
      await setConnection(null);
      await chrome.storage.local.remove("authLost");
      await syncSelfBlockRule();
      await outbox.clear();
      await chrome.storage.local.remove(["eventsCursor", "unseenOpens"]);
      await updateBadge(0);
      await broadcast({ type: "stateChanged" });
      return { ok: true };
    }

    case "setPrefs": {
      const prefs = await setPrefs(req.prefs);
      await broadcast({ type: "stateChanged" });
      return { prefs };
    }

    case "pollNow":
      // Don't just join a check that started earlier: wait for it, then check again.
      await ticking;
      await tick(true);
      return { ok: true };

    case "markSeen": {
      // Returns when you last looked, so the popup can highlight what's new since then. The popup
      // passes the newest open it showed (server time), so this never depends on this computer's clock.
      const { lastSeenAt } = await chrome.storage.local.get("lastSeenAt");
      const prev = typeof lastSeenAt === "number" ? lastSeenAt : null;
      const upTo = typeof req.seenUpTo === "number" ? Math.max(req.seenUpTo, prev ?? 0) : serverNow();
      await chrome.storage.local.set({ unseenOpens: 0, lastSeenAt: upTo });
      await updateBadge(0);
      return { ok: true, since: prev };
    }

    case "openOptions":
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    case "exportConnection":
      return { code: encodeConnectionCode(await requireConnection()) };

    case "importConnection":
      return importConnection(req.code);

    case "followUp":
      await openFollowUp(req.sender, req.threadId, req.body, req.copied);
      return { ok: true };
  }
}

/** Join an account that another browser already uses (see encodeConnectionCode). */
async function importConnection(code: string): Promise<Responses["importConnection"]> {
  const conn = decodeConnectionCode(code);
  if (!conn) return { ok: false, error: "That doesn't look like a Seen connection code." };
  try {
    const me = await call<{ userId: string }>(conn, "GET", "/api/me");
    if (me.userId !== conn.userId) return { ok: false, error: "That connection code doesn't match its account." };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { ok: false, error: "That connection code is no longer valid (was that browser disconnected?)." };
    }
    if (err instanceof ApiError && err.status === 0) return { ok: false, error: `Can't reach ${conn.serverUrl}.` };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  await setConnection(conn);
  await chrome.storage.local.remove("authLost");
  await syncSelfBlockRule();
  await chrome.storage.local.remove(["eventsCursor", "unseenOpens"]);
  await outbox.clear();
  await ensureAlarm();
  await updateBadge(0);
  await broadcast({ type: "stateChanged" });
  void tick();
  return { ok: true };
}

async function connect(input: string, inviteCode: string): Promise<Responses["connect"]> {
  const serverUrl = normaliseServerUrl(input);
  if (!serverUrl) return { ok: false, error: "Enter your server's https:// address." };
  try {
    const health = await call<{ ok?: boolean }>({ serverUrl }, "GET", "/health");
    if (!health?.ok) return { ok: false, error: "That address doesn't look like a Seen server." };
    const reg = await call<RegisterResponse>({ serverUrl }, "POST", "/api/register", {
      inviteCode: inviteCode.trim(),
    });
    await setConnection({ serverUrl, userId: reg.userId, apiKey: reg.apiKey, mintKey: reg.mintKey });
    await chrome.storage.local.remove("authLost");
    await syncSelfBlockRule();
    await chrome.storage.local.remove(["eventsCursor", "unseenOpens"]);
    await updateBadge(0);
    await outbox.clear();
    await ensureAlarm();
    await broadcast({ type: "stateChanged" });
    void tick();
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 403) return { ok: false, error: "That invite code isn't right." };
      if (err.status === 0) return { ok: false, error: `Can't reach ${serverUrl}. Check the address.` };
      if (err.status === 404) return { ok: false, error: "That address doesn't look like a Seen server." };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
