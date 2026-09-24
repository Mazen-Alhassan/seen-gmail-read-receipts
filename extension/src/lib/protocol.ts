/** Messages between the Gmail content script / popup / options page and the service worker. */

import type {
  MessageDetail,
  MessageSummary,
  OpenNotification,
  PutMessageRequest,
} from "../../../shared/api";
import type { Prefs } from "./config";

export interface State {
  connected: boolean;
  serverUrl: string | null;
  serverHost: string | null;
  userId: string | null;
  prefs: Prefs;
  /** Registrations/updates waiting to reach the server (e.g. while offline). */
  pending: number;
  /** "auth": the server no longer accepts this browser's key (disconnected elsewhere?). */
  problem?: "auth" | null;
}

export type Request =
  | { type: "state" }
  | { type: "mintTokens"; count: number }
  | { type: "register"; token: string; message: PutMessageRequest }
  | { type: "untrack"; token: string }
  | { type: "selfViews"; tokens: string[] }
  | { type: "lookup"; tokens?: string[]; threadIds?: string[]; messageIds?: string[]; sender?: string }
  | { type: "detail"; token: string }
  | { type: "list"; limit?: number }
  | { type: "connect"; serverUrl: string; inviteCode: string }
  | { type: "disconnect"; deleteData: boolean }
  | { type: "setPrefs"; prefs: Partial<Prefs> }
  | { type: "pollNow" }
  | { type: "markSeen"; seenUpTo?: number }
  | { type: "openOptions" }
  | { type: "exportConnection" }
  | { type: "importConnection"; code: string };

export interface Responses {
  state: State;
  mintTokens: { tokens: string[] };
  register: { ok: true };
  untrack: { ok: true };
  selfViews: { ok: true };
  lookup: { messages: MessageSummary[] };
  detail: { message: MessageDetail | null };
  list: { messages: MessageSummary[] };
  connect: { ok: true } | { ok: false; error: string };
  disconnect: { ok: true } | { ok: false; error: string };
  setPrefs: { prefs: Prefs };
  pollNow: { ok: true };
  markSeen: { ok: true; since: number | null };
  openOptions: { ok: true };
  exportConnection: { code: string };
  importConnection: { ok: true } | { ok: false; error: string };
}

/** Pushed from the service worker to open Gmail tabs. */
export type Push =
  | { type: "opened"; events: OpenNotification[] }
  | { type: "stateChanged" };

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

export async function send<R extends Request>(req: R): Promise<Responses[R["type"]]> {
  const reply = (await chrome.runtime.sendMessage(req)) as Reply<Responses[R["type"]]> | undefined;
  if (!reply) throw new Error("No response from Seen background worker");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

export function wrapReply<T>(p: Promise<T>): Promise<Reply<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
  );
}
