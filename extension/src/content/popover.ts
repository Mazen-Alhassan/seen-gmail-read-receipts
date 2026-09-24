/**
 * The little card that opens when you click a status icon on one of your sent messages.
 * Rendered in a shadow root so Gmail's CSS and ours never collide.
 */

import type { MessageDetail, OpenEvent } from "../../../shared/api";
import { absoluteTime, recipientsLabel, relativeTime, statusLine } from "../lib/format";
import { statusSvg } from "./icons";

export interface PopoverDeps {
  load(token: string): Promise<MessageDetail | null>;
  untrack(token: string): Promise<void>;
}

const CSS = `
:host { all: initial; }
.card {
  position: fixed; z-index: 2147483000; width: 312px; max-height: min(420px, 70vh);
  display: flex; flex-direction: column; box-sizing: border-box;
  background: var(--bg); color: var(--fg); border-radius: 12px;
  box-shadow: 0 4px 8px 3px rgba(60,64,67,.15), 0 1px 3px rgba(60,64,67,.3);
  font: 13px/1.45 "Google Sans Text", Roboto, system-ui, -apple-system, sans-serif;
  --bg: #fff; --fg: #1f1f1f; --muted: #5e5e5e; --faint: #8a8a8a; --line: #e3e3e3; --hover: #f2f2f2;
  --accent: #0b57d0; --green: #188038; --amber: #b06000;
  animation: in .12s ease-out;
}
.card.dark {
  --bg: #2d2e30; --fg: #e3e3e3; --muted: #c4c7c5; --faint: #9aa0a6; --line: #444746; --hover: #37393b;
  --accent: #a8c7fa; --green: #6dd58c; --amber: #ffb870;
}
@keyframes in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.head { display: flex; gap: 10px; padding: 14px 16px 10px; align-items: flex-start; }
.head svg { flex: none; margin-top: 2px; }
.title { font: 500 14px/1.35 "Google Sans", Roboto, system-ui, sans-serif; }
.sub { color: var(--muted); margin-top: 2px; }
.note { margin: 0 16px 10px; padding: 8px 10px; border-radius: 8px; background: var(--hover); color: var(--muted); font-size: 12px; }
.list { overflow-y: auto; padding: 2px 0 6px; border-top: 1px solid var(--line); }
.row { display: grid; grid-template-columns: 14px 1fr auto; gap: 8px; padding: 7px 16px; align-items: baseline; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); transform: translateY(-1px); }
.row.repeat .dot { background: transparent; border: 1.5px solid var(--green); width: 4px; height: 4px; }
.row.ignored { color: var(--faint); }
.row.ignored .dot { background: var(--line); }
.row .when { color: var(--muted); white-space: nowrap; font-size: 12px; }
.row.ignored .when { color: var(--faint); }
.empty { padding: 12px 16px; color: var(--muted); }
.foot { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px 8px 16px; border-top: 1px solid var(--line); }
button {
  all: unset; cursor: pointer; font: 500 12px/1 "Google Sans", Roboto, system-ui, sans-serif;
  color: var(--accent); padding: 8px 10px; border-radius: 16px;
}
button:hover { background: var(--hover); }
button:focus-visible { outline: 2px solid var(--accent); }
button.quiet { color: var(--muted); font-weight: 400; }
.to { color: var(--faint); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
`;

let current: { host: HTMLElement; cleanup: () => void } | null = null;

export function closePopover(): void {
  current?.cleanup();
  current = null;
}

export function showPopover(anchor: Element, token: string, deps: PopoverDeps): void {
  closePopover();

  const host = document.createElement("div");
  host.setAttribute("data-seen-popover", "");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${CSS}</style><div class="card" role="dialog" aria-label="Email opens"></div>`;
  const card = root.querySelector(".card") as HTMLElement;
  if (isDarkGmail()) card.classList.add("dark");
  document.body.appendChild(host);

  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  };

  const onPointer = (e: Event) => {
    if (!e.composedPath().includes(host) && !e.composedPath().includes(anchor)) closePopover();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closePopover();
  };
  const onScroll = (e: Event) => {
    if (!e.composedPath().includes(host)) closePopover();
  };
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", closePopover);

  current = {
    host,
    cleanup: () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", closePopover);
      host.remove();
    },
  };

  card.innerHTML = `<div class="empty">Loading…</div>`;
  place();

  deps.load(token).then(
    (detail) => {
      if (current?.host !== host) return;
      render(card, detail, token, deps);
      place();
    },
    () => {
      if (current?.host !== host) return;
      card.innerHTML = `<div class="empty">Couldn't reach your Seen server. Try again in a moment.</div>`;
      place();
    },
  );
}

function render(card: HTMLElement, d: MessageDetail | null, token: string, deps: PopoverDeps): void {
  if (!d) {
    card.innerHTML = `<div class="empty">This email isn't being tracked (anymore).</div>`;
    return;
  }

  const counted = d.events.filter((e) => e.kind === "open" || e.kind === "repeat");
  const ignored = d.events.filter((e) => e.kind !== "open" && e.kind !== "repeat");
  const title =
    d.status === "opened" ? `Opened${d.opens > 1 ? ` ${d.opens} times` : ""}` :
    d.status === "unconfirmed" ? "Delivered, open not confirmed" : "Not opened yet";
  const sub =
    d.status === "opened" && d.firstOpenAt
      ? `First opened ${absoluteTime(d.firstOpenAt)} · last ${relativeTime(d.lastOpenAt ?? d.firstOpenAt)}`
      : `Sent ${absoluteTime(d.sentAt)} (${relativeTime(d.sentAt)})`;

  card.innerHTML = `
    <div class="head">
      ${statusSvg(d.status, 18)}
      <div><div class="title"></div><div class="sub"></div></div>
    </div>
    ${d.status === "unconfirmed" ? `<div class="note">The recipient's mail app (Apple Mail Privacy Protection or Proton) loads every email automatically, so Seen can't tell whether they actually read it.</div>` : ""}
    ${d.recipients.length > 1 ? `<div class="note">Sent to ${d.recipients.length} people — Seen can't tell which of them opened it.</div>` : ""}
    <div class="list"></div>
    <div class="foot"><span class="to"></span><span><button class="quiet" data-act="ignored"></button><button data-act="stop">Stop tracking</button></span></div>
  `;
  (card.querySelector(".title") as HTMLElement).textContent = title;
  (card.querySelector(".sub") as HTMLElement).textContent = sub;
  (card.querySelector(".to") as HTMLElement).textContent = `To ${recipientsLabel(d.recipients)}`;
  (card.querySelector(".to") as HTMLElement).title = d.recipients.map((r) => r.email).join(", ");

  const list = card.querySelector(".list") as HTMLElement;
  const toggle = card.querySelector('[data-act="ignored"]') as HTMLButtonElement;
  let showIgnored = false;

  const draw = () => {
    const events = (showIgnored ? d.events : counted).slice().sort((a, b) => b.at - a.at);
    list.replaceChildren(...events.map(row));
    if (events.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent =
        d.status === "unconfirmed" ? "No confirmed opens." : "No opens yet. You'll get a notification when it happens.";
      list.replaceChildren(empty);
    }
    toggle.hidden = ignored.length === 0;
    toggle.textContent = showIgnored ? "Hide ignored" : `${ignored.length} ignored`;
    toggle.title = "Your own views, automatic prefetches and security scanners";
  };
  toggle.addEventListener("click", () => {
    showIgnored = !showIgnored;
    draw();
  });
  draw();

  const stop = card.querySelector('[data-act="stop"]') as HTMLButtonElement;
  stop.addEventListener("click", async () => {
    stop.textContent = "Stopping…";
    try {
      await deps.untrack(token);
      closePopover();
    } catch {
      stop.textContent = "Try again";
    }
  });

  card.setAttribute("aria-label", `${statusLine(d)}`);
}

function row(e: OpenEvent): HTMLElement {
  const el = document.createElement("div");
  const counted = e.kind === "open" || e.kind === "repeat";
  el.className = `row ${counted ? e.kind : "ignored"}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  const what = document.createElement("span");
  what.textContent = e.kind === "repeat" ? `${e.detail} (again)` : e.detail;
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = absoluteTime(e.at);
  when.title = new Date(e.at).toLocaleString();
  el.append(dot, what, when);
  return el;
}

/** Gmail's dark themes paint the main surface dark; match it. */
function isDarkGmail(): boolean {
  const bg = getComputedStyle(document.body).backgroundColor;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 90;
}
