/**
 * Seen's own small messages inside Gmail.
 *
 * They're drawn by us (not Gmail's/InboxSDK's message bar) so that Gmail's "Message sent · Undo"
 * bar can't hide them — and they can't hide Undo either: they sit just above it.
 *
 * Every situation where an email would go out untracked gets a message: silent failure is the
 * worst outcome for a tracker.
 */

import { send } from "../lib/protocol";

export type NoticeKind =
  | "not-connected" // this browser's Seen isn't connected to a server
  | "auth-lost" // the server no longer accepts this browser's key
  | "stale" // the extension was updated/reloaded under this tab
  | "sent-not-connected"
  | "sent-stale"
  | "sent-plain-text"
  | "sent-no-token"
  | "sent-not-hooked"
  | "sent-scheduled"
  | "scheduled";

interface Button {
  title: string;
  onClick: () => void;
}

const openSetup: Button = { title: "Set up", onClick: () => void send({ type: "openOptions" }).catch(() => undefined) };
const refresh: Button = { title: "Refresh", onClick: () => location.reload() };

const NOTICES: Record<NoticeKind, { text: string; button?: Button; sticky: boolean }> = {
  "not-connected": {
    text: "Seen isn't connected in this browser, so your emails aren't being tracked.",
    button: openSetup,
    sticky: true,
  },
  "auth-lost": {
    text: "Your Seen server no longer recognises this browser, so emails aren't being tracked. Reconnect in settings.",
    button: openSetup,
    sticky: true,
  },
  stale: { text: "Seen was updated. Refresh Gmail to keep tracking your emails.", button: refresh, sticky: true },
  "sent-not-connected": {
    text: "That email went out untracked: Seen isn't connected in this browser.",
    button: openSetup,
    sticky: false,
  },
  "sent-stale": {
    text: "That email went out untracked: Seen was updated. Refresh Gmail to track the next one.",
    button: refresh,
    sticky: false,
  },
  "sent-plain-text": { text: "That email went out untracked: plain-text emails can't carry a read receipt.", sticky: false },
  "sent-no-token": {
    text: "That email went out untracked: Seen couldn't reach its background service. Try again in a moment.",
    sticky: false,
  },
  "sent-not-hooked": {
    text: "That email went out untracked: Gmail sent it without passing it through Seen.",
    sticky: false,
  },
  "sent-scheduled": { text: "Scheduled emails aren't tracked yet, so this one won't be.", sticky: false },
  scheduled: { text: "Heads up: Seen can't track scheduled emails yet. Use Send to track this one.", sticky: false },
};

const STATUS_KEY = "status";

export function showNotice(kind: NoticeKind): void {
  const n = NOTICES[kind];
  showToast(n.text, { button: n.button, key: n.sticky ? STATUS_KEY : kind, timeoutMs: n.sticky ? 0 : 20_000 });
}

export function hideStatusNotice(): void {
  hideToast(STATUS_KEY);
}

/** Shown when the Gmail integration itself couldn't start. */
export function showFallbackBanner(text: string): () => void {
  showToast(text, { key: "fallback", timeoutMs: 0 });
  return () => hideToast("fallback");
}

// ---------------------------------------------------------------------------------------------

const CSS = `
:host { all: initial; }
.stack { position: fixed; left: 24px; bottom: 88px; z-index: 2147483000; display: flex; flex-direction: column;
  gap: 8px; align-items: flex-start; pointer-events: none; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 4px; max-width: 460px; min-height: 44px;
  box-sizing: border-box; padding: 6px 6px 6px 16px; border-radius: 6px; background: #313235; color: #f2f2f2;
  font: 14px/1.4 "Google Sans Text", Roboto, system-ui, -apple-system, sans-serif;
  box-shadow: 0 3px 5px -1px rgba(0,0,0,.2), 0 6px 10px 0 rgba(0,0,0,.14), 0 1px 18px 0 rgba(0,0,0,.12);
  animation: in .15s ease-out; }
@keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.text { flex: 1; padding: 6px 8px 6px 0; }
button { all: unset; cursor: pointer; border-radius: 4px; padding: 8px 10px; font: 500 14px/1 "Google Sans", Roboto, system-ui, sans-serif; }
button.action { color: #a8c7fa; }
button.close { color: #c4c7c5; padding: 8px; font-size: 18px; line-height: 14px; }
button:hover { background: rgba(255,255,255,.08); }
button:focus-visible { outline: 2px solid #a8c7fa; }
`;

let stack: HTMLElement | null = null;
const toasts = new Map<string, { el: HTMLElement; timer: ReturnType<typeof setTimeout> | null }>();

function ensureStack(): HTMLElement {
  if (stack?.isConnected) return stack;
  const host = document.createElement("div");
  host.setAttribute("data-seen-toasts", "");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${CSS}</style><div class="stack" role="status" aria-live="polite"></div>`;
  (document.body ?? document.documentElement).appendChild(host);
  stack = root.querySelector(".stack") as HTMLElement;
  return stack;
}

export function showToast(
  text: string,
  opts: { button?: Button; key?: string; timeoutMs?: number } = {},
): void {
  const key = opts.key ?? `t${Math.random()}`;
  hideToast(key);
  const el = document.createElement("div");
  el.className = "toast";
  const span = document.createElement("span");
  span.className = "text";
  span.textContent = text;
  el.append(span);
  if (opts.button) {
    const b = document.createElement("button");
    b.className = "action";
    b.textContent = opts.button.title;
    const { onClick } = opts.button;
    b.addEventListener("click", () => {
      hideToast(key);
      onClick();
    });
    el.append(b);
  }
  const close = document.createElement("button");
  close.className = "close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => hideToast(key));
  el.append(close);

  ensureStack().append(el);
  const timeoutMs = opts.timeoutMs ?? 8_000;
  toasts.set(key, { el, timer: timeoutMs > 0 ? setTimeout(() => hideToast(key), timeoutMs) : null });
}

export function hideToast(key: string): void {
  const t = toasts.get(key);
  if (!t) return;
  if (t.timer) clearTimeout(t.timer);
  t.el.remove();
  toasts.delete(key);
}
