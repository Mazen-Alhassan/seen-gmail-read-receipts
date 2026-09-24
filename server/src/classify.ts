import type { Client, HitKind, MessageSummary } from "../../shared/api";
import { identify, type Source } from "./sources";

/**
 * A self-view beacon explains a hit only if the hit came through Google's image proxy (the only way
 * the sender's own Gmail loads images) and landed right around the beacon: the proxy fetch happens
 * as the message renders, so it arrives from slightly before to a few seconds after the beacon.
 * Anything further away is someone else reading — e.g. you open it on your phone, then glance at
 * your Sent folder a few seconds later.
 */
export const SELF_VIEW_BEFORE_MS = 3_000;
export const SELF_VIEW_AFTER_MS = 8_000;
/**
 * The timing windows below are measured from when you pressed Send, but Gmail holds the email for
 * your Undo Send period (up to 30s) before delivering it, so each window includes that.
 */
export const UNDO_SEND_MAX_MS = 30_000;
/** A Gmail-proxy fetch sooner than this can't be a recipient: the email isn't even delivered yet. */
export const EARLIEST_DELIVERY_MS = 5_000;
/** A browser-like direct fetch this soon after sending is a delivery-time scanner. */
export const DELIVERY_SCAN_WINDOW_MS = UNDO_SEND_MAX_MS + 30_000;
/** When the recipient is behind a security gateway, its scans can take a little longer. */
export const GATEWAY_SCAN_WINDOW_MS = UNDO_SEND_MAX_MS + 3 * 60_000;
/** Yahoo's proxy may fetch on delivery, not only on open. */
export const YAHOO_DELIVERY_WINDOW_MS = UNDO_SEND_MAX_MS + 90_000;
/** Outlook.com readers: Microsoft-network fetches this soon after sending are filtering. */
export const MICROSOFT_SCAN_WINDOW_MS = UNDO_SEND_MAX_MS + 30_000;
/** Anyone else: Microsoft 365 (Defender, delayed delivery) keeps scanning for longer. */
export const MICROSOFT_365_SCAN_WINDOW_MS = UNDO_SEND_MAX_MS + 15 * 60_000;
/** The same reader again within this window (from their first fetch) is one reading session. */
export const REPEAT_WINDOW_MS = 3 * 60_000;
/** Shorter for shared proxies when several people got the email, so each of them counts. */
export const SHARED_PROXY_REPEAT_MS = 45_000;

/** Personal Microsoft mailboxes (Outlook.com), where Microsoft's servers load images for the reader. */
const MICROSOFT_CONSUMER_DOMAIN = /^(outlook|hotmail|live|msn|windowslive|passport)\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/i;

export function isMicrosoftConsumer(email: string): boolean {
  return MICROSOFT_CONSUMER_DOMAIN.test(email.split("@")[1]?.trim() ?? "");
}

/** Canonical form of an address, so "Jane.Doe+work@gmail.com" and "janedoe@gmail.com" match. */
export function canonicalEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.split("+")[0]!.replace(/\./g, "")}@gmail.com`;
  }
  return `${local}@${domain}`;
}

export interface Hit {
  ts: number;
  ip: string | null;
  ua: string | null;
  asn: number | null;
  asOrg: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
}

export interface MessageContext {
  sentAt: number;
  /** IP and UA the extension registered the email from — i.e. the sender's own browser. */
  senderIp: string | null;
  senderUa: string | null;
  /** Security gateway in front of the recipients (from their MX records), if any. */
  gateway: string | null;
  /**
   * Whether any recipient is a personal Outlook.com/Hotmail mailbox, where Microsoft's servers
   * load images for the reader. For everyone else, Microsoft-network fetches right after delivery
   * are Microsoft 365 security scanning.
   */
  microsoftConsumer: boolean;
  /** Every recipient is the sender (a note to self): all Gmail opens are the sender's own. */
  toSelfOnly: boolean;
  /** The sender is one of several recipients (cc/bcc self): a Gmail open could be their copy. */
  selfAmongRecipients: boolean;
  recipientCount: number;
}

export interface Classified {
  hit: Hit;
  source: Source;
  kind: HitKind;
  client: Client;
  detail: string;
}

/**
 * Decide what each pixel request meant. Pure, and re-run on every read — so a signal that
 * arrives after its hit (e.g. a late "that was me" beacon) is always taken into account.
 */
export function classify(msg: MessageContext, hits: Hit[], selfViews: number[]): Classified[] {
  const sorted = [...hits].sort((a, b) => a.ts - b.ts);
  const out: Classified[] = [];
  // Start of each reader's current reading session.
  const sessionStart = new Map<string, number>();

  for (const hit of sorted) {
    const source = identify(hit);
    const sinceSend = hit.ts - msg.sentAt;
    const verdict = judge(msg, hit, source, sinceSend, selfViews);
    let kind: HitKind;
    let detail: string;

    if (verdict) {
      [kind, detail] = verdict;
    } else {
      const reader = readerKey(hit, source);
      const start = sessionStart.get(reader);
      const window =
        source.via !== "direct" && msg.recipientCount > 1 ? SHARED_PROXY_REPEAT_MS : REPEAT_WINDOW_MS;
      if (start !== undefined && hit.ts - start <= window) {
        kind = "repeat";
      } else {
        kind = "open";
        sessionStart.set(reader, hit.ts);
      }
      // Proxied fetches come from the proxy's data centre, so location only means something direct.
      const where = source.via === "direct" && !source.relayed ? place(hit) : null;
      detail = where ? `${source.label} · ${where}` : source.label;
      if (source.via === "google_proxy" && msg.selfAmongRecipients) detail += " (could be your own copy)";
    }

    out.push({ hit, source, kind, client: source.client, detail });
  }
  return out;
}

/** Everything that isn't a person opening the email; null means it is one. */
function judge(
  msg: MessageContext,
  hit: Hit,
  source: Source,
  sinceSend: number,
  selfViews: number[],
): [HitKind, string] | null {
  if (source.via === "google_proxy") {
    if (selfViews.some((v) => hit.ts >= v - SELF_VIEW_BEFORE_MS && hit.ts <= v + SELF_VIEW_AFTER_MS)) {
      return ["self", "You, viewing your sent email (ignored)"];
    }
    if (msg.toSelfOnly) return ["self", "You (you sent this to yourself)"];
    if (sinceSend < EARLIEST_DELIVERY_MS) return ["self", "Before delivery, so it was you (ignored)"];
    return null;
  }

  // The sender's own browser fetching the pixel directly. Not on shared exits (a coworker behind
  // the same corporate gateway would look identical).
  if (
    source.via === "direct" &&
    !source.relayed &&
    msg.senderIp !== null &&
    hit.ip === msg.senderIp &&
    (msg.senderUa === null || hit.ua === msg.senderUa)
  ) {
    return ["self", "You, viewing your sent email (ignored)"];
  }

  switch (source.via) {
    case "scanner":
      return ["bot", `${source.label} (ignored)`];
    case "gmail_prefetch":
      return ["prefetch", "Gmail preloaded it on delivery — not a read (ignored)"];
    case "privacy_proxy":
      return ["prefetch", `${source.label} loaded it automatically — can't confirm a read`];
    case "yahoo_proxy":
      return sinceSend < YAHOO_DELIVERY_WINDOW_MS ? ["bot", "Yahoo filtering on delivery (ignored)"] : null;
    case "outlook_proxy":
      if (source.defender) return ["bot", "Microsoft 365 security scan (ignored)"];
      if (msg.microsoftConsumer) {
        return sinceSend < MICROSOFT_SCAN_WINDOW_MS ? ["bot", "Microsoft filtering on delivery (ignored)"] : null;
      }
      return sinceSend < MICROSOFT_365_SCAN_WINDOW_MS ? ["bot", "Microsoft 365 security scan (ignored)"] : null;
    case "direct":
      // Real mail apps are people. Browser-like fetches straight after delivery are scanners.
      if (source.mailApp) return null;
      if (sinceSend < DELIVERY_SCAN_WINDOW_MS) {
        return ["bot", "Loaded right after delivery — likely a security scan (ignored)"];
      }
      if (msg.gateway && sinceSend < GATEWAY_SCAN_WINDOW_MS) {
        return ["bot", `Security scanner (${msg.gateway}) (ignored)`];
      }
      return null;
  }
}

/**
 * Who's reading. Proxies hide the reader, so all fetches via one proxy are one reader. Direct
 * fetches are keyed by app and network rather than exact IP, because one device can switch between
 * IPv4 and IPv6 (or rotate IPv6 addresses) between two fetches.
 */
function readerKey(hit: Hit, source: Source): string {
  if (source.via !== "direct") return source.via;
  return `direct|${hit.ua}|${hit.asn ?? ipPrefix(hit.ip)}`;
}

function ipPrefix(ip: string | null): string {
  if (!ip) return "";
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
}

function place(hit: Hit): string | null {
  const parts = [hit.city, hit.country].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function summarize(
  classified: Classified[],
): Pick<MessageSummary, "status" | "opens" | "firstOpenAt" | "lastOpenAt" | "lastClient"> {
  let opens = 0;
  let firstOpenAt: number | null = null;
  let lastOpenAt: number | null = null;
  let lastClient: Client | null = null;
  let privacyProxied = false;

  for (const c of classified) {
    if (c.kind === "open") {
      opens++;
      firstOpenAt ??= c.hit.ts;
    }
    if (c.kind === "open" || c.kind === "repeat") {
      lastOpenAt = c.hit.ts;
      lastClient = c.client;
    }
    if (c.kind === "prefetch" && c.source.via === "privacy_proxy") privacyProxied = true;
  }

  return {
    status: opens > 0 ? "opened" : privacyProxied ? "unconfirmed" : "sent",
    opens,
    firstOpenAt,
    lastOpenAt,
    lastClient,
  };
}
