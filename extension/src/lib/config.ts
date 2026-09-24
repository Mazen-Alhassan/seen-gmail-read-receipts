/** Persistent settings, stored in chrome.storage.local. */

import { b64urlDecode, b64urlEncode } from "../../../shared/token";

export type NotifyMode = "first" | "every" | "off";

export interface Connection {
  serverUrl: string; // origin only, e.g. "https://seen.example.com"
  userId: string;
  apiKey: string;
  mintKey: string;
}

export interface Prefs {
  /** New emails are tracked unless you switch it off in the compose window. */
  trackByDefault: boolean;
  /** Desktop notifications for opens. */
  notify: NotifyMode;
  /** Small toast inside Gmail when an email is opened. */
  inGmailToasts: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  trackByDefault: true,
  notify: "first",
  inGmailToasts: true,
};

// Replaced at build time (see build.mjs).
declare const __DEFAULT_SERVER_URL__: string;
export const DEFAULT_SERVER_URL: string =
  typeof __DEFAULT_SERVER_URL__ === "string" ? __DEFAULT_SERVER_URL__ : "";

export async function getConnection(): Promise<Connection | null> {
  const { connection } = await chrome.storage.local.get("connection");
  return (connection as Connection | undefined) ?? null;
}

export async function setConnection(connection: Connection | null): Promise<void> {
  if (connection) await chrome.storage.local.set({ connection });
  else await chrome.storage.local.remove("connection");
}

export async function getPrefs(): Promise<Prefs> {
  const { prefs } = await chrome.storage.local.get("prefs");
  return { ...DEFAULT_PREFS, ...(prefs as Partial<Prefs> | undefined) };
}

export async function setPrefs(update: Partial<Prefs>): Promise<Prefs> {
  const prefs = { ...(await getPrefs()), ...update };
  await chrome.storage.local.set({ prefs });
  return prefs;
}

/** Normalise user input like "seen.example.com/" to "https://seen.example.com". */
export function normaliseServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const url = new URL(s);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !local) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const CODE_PREFIX = "seen1_";

/**
 * A connection code lets another browser join this same account, so both share one list of
 * tracked emails and both recognise (and block) your own views. It contains the API key: treat it
 * like a password.
 */
export function encodeConnectionCode(c: Connection): string {
  const json = JSON.stringify({ s: c.serverUrl, u: c.userId, k: c.apiKey, m: c.mintKey });
  return CODE_PREFIX + b64urlEncode(new TextEncoder().encode(json));
}

export function decodeConnectionCode(code: string): Connection | null {
  const raw = code.trim();
  if (!raw.startsWith(CODE_PREFIX)) return null;
  const bytes = b64urlDecode(raw.slice(CODE_PREFIX.length));
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const serverUrl = typeof v.s === "string" ? normaliseServerUrl(v.s) : null;
    if (!serverUrl || typeof v.u !== "string" || typeof v.k !== "string" || typeof v.m !== "string") return null;
    return { serverUrl, userId: v.u, apiKey: v.k, mintKey: v.m };
  } catch {
    return null;
  }
}
