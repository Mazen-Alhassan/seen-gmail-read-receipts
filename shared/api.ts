/** Types shared by the server API and the extension. */

export interface Recipient {
  name?: string;
  email: string;
}

/** Which mail client/proxy fetched the pixel, as best we can tell. */
export type Client =
  | "gmail"
  | "apple_mail"
  | "outlook"
  | "yahoo"
  | "thunderbird"
  | "webmail"
  | "unknown";

/**
 * How a pixel request was interpreted.
 *  - open:     a real person opening the email
 *  - repeat:   same reader again within a few minutes (not counted as a new open)
 *  - self:     you, viewing your own sent message
 *  - prefetch: fetched automatically by a privacy proxy (Apple Mail Privacy Protection)
 *  - bot:      a security scanner or other automated fetch
 */
export type HitKind = "open" | "repeat" | "self" | "prefetch" | "bot";

export type MessageStatus = "sent" | "opened" | "unconfirmed";

export interface OpenEvent {
  at: number;
  kind: HitKind;
  client: Client;
  /** Human-readable detail, e.g. "Outlook on Windows · Ottawa, CA". */
  detail: string;
}

export interface MessageSummary {
  token: string;
  sender: string;
  subject: string;
  recipients: Recipient[];
  sentAt: number;
  threadId: string | null;
  messageId: string | null;
  status: MessageStatus;
  /** Counted opens (excludes repeats, self-views, prefetches and bots). */
  opens: number;
  firstOpenAt: number | null;
  lastOpenAt: number | null;
  lastClient: Client | null;
}

export interface MessageDetail extends MessageSummary {
  events: OpenEvent[];
}

export interface OpenNotification {
  token: string;
  sender: string;
  subject: string;
  recipients: Recipient[];
  threadId: string | null;
  at: number;
  client: Client;
  detail: string;
  /** True if this is the first counted open of the message. */
  first: boolean;
}

// ---- Request/response bodies ----

export interface RegisterRequest {
  inviteCode?: string;
}
export interface RegisterResponse {
  userId: string;
  apiKey: string;
  mintKey: string;
}

export interface PutMessageRequest {
  sender: string;
  subject: string;
  recipients: Recipient[];
  /** When it was sent, by the sender's clock (corrected on the server using clientNow). */
  sentAt?: number;
  /** The sender's clock at the moment this request was made: lets the server undo clock skew. */
  clientNow?: number;
  threadId?: string | null;
  messageId?: string | null;
}

export interface LookupRequest {
  tokens?: string[];
  threadIds?: string[];
  messageIds?: string[];
  /** The Gmail account asking: thread/message ids are only matched within it. */
  sender?: string;
}
export interface LookupResponse {
  messages: MessageSummary[];
}

export interface ListResponse {
  messages: MessageSummary[];
}

export interface SelfViewRequest {
  tokens: string[];
  /** When the sender's Gmail displayed them, by the sender's clock. Lets a retried beacon line up. */
  at?: number;
  /** The sender's clock at the moment this request was made: lets the server undo clock skew. */
  clientNow?: number;
}

export interface EventsResponse {
  events: OpenNotification[];
  /** Pass back as `since` on the next poll. */
  cursor: number;
}
