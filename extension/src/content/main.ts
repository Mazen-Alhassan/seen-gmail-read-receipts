import * as InboxSDK from "@inboxsdk/core";
import type { OpenNotification } from "../../../shared/api";
import { notificationTitle } from "../lib/format";
import { send, type Push, type State } from "../lib/protocol";
import { startSelfViewBeacon } from "./beacon";
import {
  extensionAlive,
  refreshComposeButtons,
  setupCompose,
  startFollowUp,
  setupMessageViews,
  setupThreadRows,
  type GmailContext,
} from "./gmail";
import { hideStatusNotice, showFallbackBanner, showNotice, showToast } from "./notices";
import { closePopover } from "./popover";
import { StatusStore } from "./store";
import { TokenPool } from "./tokens";

declare const __INBOXSDK_APP_ID__: string;

const REFRESH_MS = 60_000;

const OFFLINE_STATE: State = {
  connected: false,
  serverUrl: null,
  serverHost: null,
  userId: null,
  prefs: { trackByDefault: true, notify: "first", inGmailToasts: true },
  pending: 0,
};

/** Ask the background service for its state, retrying a few times while it wakes up. */
async function fetchState(): Promise<State | null> {
  for (const wait of [0, 500, 1_500, 4_000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (!extensionAlive()) return null;
    try {
      return await send({ type: "state" });
    } catch {
      /* not awake yet */
    }
  }
  return null;
}

async function main(): Promise<void> {
  let state = (await fetchState()) ?? OFFLINE_STATE;

  // Start watching for our own pixels immediately, before InboxSDK (which takes a moment) loads.
  let stopBeacon: (() => void) | null = null;
  const restartBeacon = () => {
    stopBeacon?.();
    stopBeacon = null;
    if (state.connected && state.serverHost && state.userId) {
      stopBeacon = startSelfViewBeacon(state.serverHost, state.userId, (tokens) => {
        if (extensionAlive()) void send({ type: "selfViews", tokens }).catch(() => undefined);
      });
    }
  };
  restartBeacon();

  // Filled in once InboxSDK knows which Gmail account this tab is.
  let account: string | undefined;
  const store = new StatusStore(async (q) => (await send({ type: "lookup", ...q, sender: account })).messages);
  const tokens = new TokenPool(async (count) => (await send({ type: "mintTokens", count })).tokens);
  if (state.connected) void tokens.fill();

  const loading = InboxSDK.load(2, __INBOXSDK_APP_ID__, {
    appName: "Seen",
    appIconUrl: chrome.runtime.getURL("icons/icon48.png"),
    // No third-party telemetry from inside your mailbox.
    eventTracking: false,
    globalErrorLogging: false,
  });
  // If the Gmail integration can't start (e.g. Gmail changed under us), say so: otherwise every
  // email would silently go out untracked.
  const trouble =
    "Seen couldn't start inside Gmail, so emails aren't being tracked right now. Refresh Gmail; if this keeps happening, Seen needs an update.";
  const banner: { hide: (() => void) | null } = { hide: null };
  const slow = setTimeout(() => (banner.hide = showFallbackBanner(trouble)), 45_000);
  let sdk: Awaited<typeof loading>;
  try {
    sdk = await loading;
  } catch (err) {
    clearTimeout(slow);
    banner.hide ??= showFallbackBanner(trouble);
    throw err;
  }
  clearTimeout(slow);
  banner.hide?.(); // it did start, just slowly

  account = sdk.User.getEmailAddress();
  const ctx: GmailContext = { sdk, store, tokens, state: () => state };
  const showDisconnected = () => showNotice(state.problem === "auth" ? "auth-lost" : "not-connected");
  if (!state.connected) showDisconnected();

  // If the extension is updated or reloaded, this (old) copy of the script can no longer talk to
  // it, so emails would go out untracked. Tell the user — and refresh by ourselves as soon as the
  // tab is in the background with nothing being written.
  const composing = () => !!document.querySelector('[g_editable="true"]');
  const reloadWhenIdle = () => {
    if (document.visibilityState === "hidden" && !composing()) location.reload();
  };
  const staleCheck = setInterval(() => {
    if (!extensionAlive()) {
      clearInterval(staleCheck);
      showNotice("stale");
      reloadWhenIdle();
      document.addEventListener("visibilitychange", reloadWhenIdle);
    }
  }, 5_000);
  setupCompose(ctx);
  setupThreadRows(ctx);
  setupMessageViews(ctx, {
    load: async (token) => (await send({ type: "detail", token })).message,
    untrack: async (token) => {
      await send({ type: "untrack", token });
      store.forget(token);
    },
  });

  const toast = (events: OpenNotification[]) => {
    if (!state.prefs.inGmailToasts || document.visibilityState !== "visible") return;
    const me = sdk.User.getEmailAddress().toLowerCase();
    const mine = events.filter((e) => e.first && e.sender.toLowerCase() === me);
    const last = mine[mine.length - 1];
    if (!last) return;
    const more = mine.length > 1 ? ` (+${mine.length - 1} more)` : "";
    // Our own toast, not Gmail's bar: that would hide Gmail's "Undo" if one is showing.
    showToast(`${notificationTitle(last)} · “${last.subject || "(no subject)"}”${more}`, {
      key: "opened",
      timeoutMs: 8_000,
    });
  };

  chrome.runtime.onMessage.addListener((msg: Push) => {
    if (msg?.type === "opened") {
      store.refreshWatched();
      toast(msg.events);
    } else if (msg?.type === "followUp") {
      void writeFollowUp(msg.threadId, msg.body);
    } else if (msg?.type === "stateChanged") {
      void send({ type: "state" }).then((next) => {
        const reconnected = next.userId !== state.userId;
        state = next;
        if (state.connected) hideStatusNotice();
        else showDisconnected();
        refreshComposeButtons();
        if (reconnected) {
          tokens.reset();
          restartBeacon();
          closePopover();
        }
        if (state.connected) void tokens.fill();
        store.refreshWatched();
      });
    }
  });

  /**
   * Gmail renders a thread a moment after the tab reports itself loaded, so wait for the reply
   * control to exist before clicking it. If it never shows up, put the text on the clipboard
   * rather than dropping it on the floor.
   */
  async function writeFollowUp(threadId: string, body: string): Promise<void> {
    for (const wait of [0, 300, 600, 1_000, 1_500, 2_000, 3_000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (!location.href.includes(threadId)) continue; // still on the way to the thread
      if (startFollowUp(body)) return;
    }
    const copied = await navigator.clipboard.writeText(body).then(() => true).catch(() => false);
    showToast(
      copied
        ? "Couldn't open the reply box, so your follow-up is copied — just paste it."
        : "Couldn't open the reply box for that follow-up.",
      { key: "follow-up", timeoutMs: 10_000 },
    );
  }

  // Keep what's on screen fresh while you're looking at it.
  setInterval(() => {
    if (document.visibilityState === "visible" && extensionAlive()) store.refreshWatched();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && extensionAlive() && state === OFFLINE_STATE) {
      // We started before the background service answered: try again now.
      void fetchState().then((next) => {
        if (!next) return;
        state = next;
        if (state.connected) {
          hideStatusNotice();
          restartBeacon();
          void tokens.fill();
          refreshComposeButtons();
        }
      });
    }
    if (document.visibilityState === "visible" && extensionAlive()) {
      store.refreshWatched();
      void send({ type: "pollNow" }).catch(() => undefined);
    }
  });
}

main().catch((err) => console.error("[Seen] failed to start", err));
