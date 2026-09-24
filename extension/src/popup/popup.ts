import type { MessageSummary } from "../../../shared/api";
import { gmailThreadUrl, recipientsLabel, relativeTime, statusLine } from "../lib/format";
import { send, type State } from "../lib/protocol";
import { statusSvg } from "../content/icons";

type Filter = "all" | "opened" | "waiting";

const STATUSES = new Set(["sent", "opened", "unconfirmed"]);

const content = document.getElementById("content") as HTMLElement;
document.getElementById("settings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());

let messages: MessageSummary[] = [];
let filter: Filter = "all";
let state: State;
/** Opens after this moment are new since you last looked (shown with a small red dot). */
let newSince = Infinity;

async function main(): Promise<void> {
  state = await send({ type: "state" });
  if (!state.connected) {
    void send({ type: "markSeen" }).catch(() => undefined);
    return renderConnect();
  }

  try {
    messages = (await send({ type: "list", limit: 40 })).messages;
  } catch (err) {
    return renderMessage("Can't reach your server", err instanceof Error ? err.message : String(err));
  }
  // "New since you last looked" is measured in the server's time, from the opens we're showing.
  const newest = Math.max(0, ...messages.map((m) => m.firstOpenAt ?? 0));
  const seen = await send({ type: "markSeen", seenUpTo: newest || undefined }).catch(() => null);
  if (seen?.since) newSince = seen.since;
  render();
}

function renderConnect(): void {
  const lost = state.problem === "auth";
  content.innerHTML = `
    <div class="empty">
      <img src="icons/icon48.png" width="40" height="40" alt="">
      <h2>${lost ? "Reconnect Seen" : "Finish setting up Seen"}</h2>
      <p>${lost ? "Your server no longer recognises this browser, so emails aren't being tracked." : "Connect to your server to start tracking opens."}</p>
      <button id="go">${lost ? "Reconnect" : "Connect"}</button>
    </div>`;
  content.querySelector("#go")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
}

function renderMessage(title: string, body: string): void {
  content.innerHTML = `<div class="empty"><h2></h2><p></p></div>`;
  (content.querySelector("h2") as HTMLElement).textContent = title;
  (content.querySelector("p") as HTMLElement).textContent = body;
}

function render(): void {
  if (messages.length === 0) {
    content.innerHTML = `
      <div class="empty">
        ${statusSvg("opened", 32)}
        <h2>No tracked emails yet</h2>
        <p>Send an email from Gmail. It'll show up here, and you'll be notified when it's opened.</p>
      </div>`;
    return;
  }

  const counts = {
    all: messages.length,
    opened: messages.filter((m) => m.status === "opened").length,
    waiting: messages.filter((m) => m.status !== "opened").length,
  };
  const shown = messages.filter(
    (m) => filter === "all" || (filter === "opened" ? m.status === "opened" : m.status !== "opened"),
  );

  content.innerHTML = `
    <div class="tabs" role="tablist">
      ${(["all", "opened", "waiting"] as const)
        .map(
          (f) =>
            `<button role="tab" data-filter="${f}" class="${f === filter ? "active" : ""}" aria-selected="${f === filter}">` +
            `${f === "all" ? "All" : f === "opened" ? "Opened" : "Not opened"} · ${counts[f]}</button>`,
        )
        .join("")}
    </div>
    ${state.pending > 0 ? `<div class="banner">${state.pending} email${state.pending > 1 ? "s" : ""} waiting to sync with your server.</div>` : ""}
    <div class="list"></div>`;

  content.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.filter as Filter;
      render();
    }),
  );

  const list = content.querySelector(".list") as HTMLElement;
  if (shown.length === 0) {
    list.innerHTML = `<div class="empty">Nothing here.</div>`;
    return;
  }
  list.replaceChildren(...shown.map(item));
}

function item(m: MessageSummary): HTMLElement {
  const el = document.createElement("div");
  el.className = "item";
  el.tabIndex = 0;
  el.title = `To: ${m.recipients.map((r) => r.email).join(", ")}`;
  const isNew = m.firstOpenAt !== null && m.firstOpenAt > newSince;
  const status = STATUSES.has(m.status) ? m.status : "sent"; // never put server text into markup
  el.innerHTML = `${statusSvg(status, 18)}<div style="min-width:0"><div class="subject">${isNew ? '<span class="new-dot" title="Opened since you last looked"></span>' : ""}<span></span></div><div class="meta ${status}"></div></div><div class="when"></div>`;
  (el.querySelector(".subject > span:last-child") as HTMLElement).textContent = m.subject || "(no subject)";
  (el.querySelector(".meta") as HTMLElement).textContent = `${recipientsLabel(m.recipients)} · ${statusLine(m)}`;
  (el.querySelector(".when") as HTMLElement).textContent = relativeTime(m.sentAt);
  const open = () => void chrome.tabs.create({ url: gmailThreadUrl(m.sender, m.threadId) });
  el.addEventListener("click", open);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") open();
  });
  return el;
}

main().catch((err) => renderMessage("Something went wrong", err instanceof Error ? err.message : String(err)));
