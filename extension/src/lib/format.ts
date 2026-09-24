import type { MessageSummary, OpenNotification, Recipient } from "../../../shared/api";

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function absoluteTime(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export function personName(r: Recipient): string {
  if (r.name) return r.name.split(/\s+/)[0] ?? r.name;
  return r.email.split("@")[0] ?? r.email;
}

/** "Alice", "Alice and Bob", "Alice +3". */
export function recipientsLabel(recipients: Recipient[]): string {
  const [first, second] = recipients;
  if (!first) return "(no recipients)";
  if (!second) return personName(first);
  if (recipients.length === 2) return `${personName(first)} and ${personName(second)}`;
  return `${personName(first)} +${recipients.length - 1}`;
}

/** One-line status, e.g. "Opened 3× · last 2h ago" / "Not opened yet · sent 5m ago". */
export function statusLine(m: MessageSummary, now = Date.now()): string {
  if (m.status === "opened" && m.lastOpenAt) {
    const times = m.opens > 1 ? ` ${m.opens}×` : "";
    return `Opened${times} · ${m.opens > 1 ? "last " : ""}${relativeTime(m.lastOpenAt, now)}`;
  }
  if (m.status === "unconfirmed") return "Delivered · their mail app hides reads";
  return `Not opened yet · sent ${relativeTime(m.sentAt, now)}`;
}

export function notificationTitle(e: OpenNotification): string {
  const who = recipientsLabel(e.recipients);
  if (e.recipients.length <= 1) return `${who} ${e.first ? "opened" : "re-opened"} your email`;
  return `Your email to ${who} was ${e.first ? "opened" : "opened again"}`;
}

export function gmailThreadUrl(sender: string, threadId: string | null): string {
  const base = `https://mail.google.com/mail/?authuser=${encodeURIComponent(sender)}`;
  return threadId ? `${base}#all/${threadId}` : `${base}#sent`;
}
