/**
 * Everything that touches Gmail's UI, via InboxSDK:
 *  - compose: a small eye toggle, and the pixel injected into the outgoing send request
 *  - thread lists: a check-mark status icon in the attachment column
 *  - opened threads: a status icon on each of your sent messages, click for the open history
 */

import type { ComposeView, InboxSDK, MessageView, ThreadRowView } from "@inboxsdk/core";
import Kefir, { type Property } from "kefir";
import type { MessageSummary, PutMessageRequest, Recipient } from "../../../shared/api";
import { extractToken, tokenUserId } from "../../../shared/token";
import { statusLine } from "../lib/format";
import { send, type State } from "../lib/protocol";
import { dataUrl, eyeSvg, statusSvg } from "./icons";
import { showNotice } from "./notices";
import { insertPixel, isPlainTextBody, pixelUrl, stripPixels } from "./pixel";
import { showPopover, type PopoverDeps } from "./popover";
import type { Key, StatusStore } from "./store";
import type { TokenPool } from "./tokens";

export interface GmailContext {
  sdk: InboxSDK;
  store: StatusStore;
  tokens: TokenPool;
  state(): State;
}

/** False once the extension has been reloaded/updated under an already-open Gmail tab. */
export function extensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------------------------

/** Re-render every open compose window's eye button (e.g. after connecting). */
const composeButtonRefreshers = new Set<() => void>();
export function refreshComposeButtons(): void {
  for (const refresh of composeButtonRefreshers) refresh();
}

export function setupCompose(ctx: GmailContext): void {
  ctx.sdk.Compose.registerComposeViewHandler((composeView) => {
    try {
      fillPendingFollowUp(composeView);
    } catch (err) {
      console.warn("[Seen] couldn't write the follow-up", err);
    }
    try {
      attachToCompose(ctx, composeView);
    } catch (err) {
      console.warn("[Seen] couldn't attach to compose window", err);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Follow-ups: text chosen in the popup, dropped into a reply here. Never sent for you.
// ---------------------------------------------------------------------------------------------

/** Text waiting for the next reply window to appear. */
let pendingFollowUp: { body: string; until: number } | null = null;

/** How long we'll wait for Gmail to open the reply box before giving up on a follow-up. */
const FOLLOW_UP_TIMEOUT_MS = 15_000;

/**
 * Open a reply on the thread that's showing and write `body` into it.
 *
 * InboxSDK can't open a reply itself, so we click Gmail's own reply button and catch the compose
 * window it creates. Returns false if we couldn't find the button — the caller then tells you, so
 * the text is never silently lost.
 */
export function startFollowUp(body: string): boolean {
  const button = findReplyButton();
  if (!button) return false;
  pendingFollowUp = { body, until: Date.now() + FOLLOW_UP_TIMEOUT_MS };
  button.click();
  return true;
}

function fillPendingFollowUp(composeView: ComposeView): void {
  const pending = pendingFollowUp;
  if (!pending) return;
  if (Date.now() > pending.until) {
    pendingFollowUp = null;
    return;
  }
  if (!composeView.isReply()) return; // a compose the user opened themselves, not ours
  pendingFollowUp = null;
  // Above the quoted thread, which is where a reply belongs.
  composeView.insertTextIntoBodyAtCursor(pending.body);
  setTimeout(() => {
    try {
      composeView.getBodyElement().focus();
    } catch {
      /* the window may already be gone */
    }
  }, 0);
}

/**
 * Gmail's reply control at the foot of a thread. Its aria-labels are translated, so the stable
 * internal class comes first and the label is only a fallback for layouts that lack it.
 */
function findReplyButton(): HTMLElement | null {
  const byClass = document.querySelector<HTMLElement>('div.ams.bkH[role="button"]');
  if (byClass) return byClass;
  const candidates = document.querySelectorAll<HTMLElement>('[role="button"][aria-label], [role="link"][aria-label]');
  for (const el of candidates) {
    const label = el.getAttribute("aria-label") ?? "";
    if (/^reply\b/i.test(label) && !/all/i.test(label)) return el;
  }
  // The collapsed "Reply" box Gmail shows under the last message.
  return document.querySelector<HTMLElement>(".aDh [role='button'], .amn [role='button']");
}

/** Tokens this tab just sent, so an Undo that reopens the email can be recognised. */
const recentlySent = new Map<string, number>();
/** Tokens whose send was undone: they must never be registered again. */
const dropped = new Set<string>();
const UNDO_WINDOW_MS = 2 * 60_000;

/**
 * If this compose window is an email you just sent and then Undid, Gmail reopens it with our pixel
 * still in the body. Returns that pixel's token: the email never went out, so it shouldn't stay
 * tracked (the re-send gets a fresh one).
 */
export function undoneToken(
  body: HTMLElement,
  host: string,
  userId: string,
  sent: Map<string, number>,
  now = Date.now(),
): string | null {
  const token = ownToken(body, host, userId);
  if (!token) return null;
  const at = sent.get(token);
  return at !== undefined && now - at <= UNDO_WINDOW_MS ? token : null;
}

function untrack(ctx: GmailContext, token: string): void {
  dropped.add(token);
  recentlySent.delete(token);
  ctx.store.forget(token);
  void send({ type: "untrack", token }).catch(() => undefined);
}

function dropUndoneSend(ctx: GmailContext, composeView: ComposeView): void {
  const st = ctx.state();
  if (!st.serverHost || !st.userId) return;
  let token: string | null;
  try {
    token = undoneToken(composeView.getBodyElement(), st.serverHost, st.userId, recentlySent);
  } catch {
    return;
  }
  if (token) untrack(ctx, token);
}

// Your on/off choice for each draft, so it survives the compose window being recreated (popping an
// inline reply out, reopening the draft, reloading Gmail).
const CHOICES_KEY = "composeChoices";
const CHOICE_TTL_MS = 30 * 86400_000;

function draftKey(composeView: ComposeView): string | null {
  try {
    const v = composeView.getElement().querySelector<HTMLInputElement>('input[name="draft"]')?.value;
    return v && v !== "undefined" && v !== "null" ? v.replace(/^#/, "") : null;
  } catch {
    return null;
  }
}

async function loadChoice(draft: string): Promise<boolean | null> {
  try {
    const { [CHOICES_KEY]: all } = await chrome.storage.local.get(CHOICES_KEY);
    const entry = (all as Record<string, { on: boolean }> | undefined)?.[draft];
    return entry ? entry.on : null;
  } catch {
    return null;
  }
}

async function saveChoice(draft: string, on: boolean): Promise<void> {
  try {
    const { [CHOICES_KEY]: all = {} } = await chrome.storage.local.get(CHOICES_KEY);
    const now = Date.now();
    const kept = Object.fromEntries(
      Object.entries(all as Record<string, { on: boolean; at: number }>).filter(([, v]) => now - v.at < CHOICE_TTL_MS),
    );
    kept[draft] = { on, at: now };
    await chrome.storage.local.set({ [CHOICES_KEY]: kept });
  } catch {
    /* extension reloaded */
  }
}

function attachToCompose(ctx: GmailContext, composeView: ComposeView): void {
  // The reopened body can take a moment to fill in, so look a few times.
  for (const delay of [0, 800, 2_500]) setTimeout(() => dropUndoneSend(ctx, composeView), delay);

  let enabled = ctx.state().prefs.trackByDefault;
  let captured: Omit<PutMessageRequest, "sentAt"> | null = null;
  let registered: { token: string; message: PutMessageRequest } | null = null;
  let modifierRan = false;
  let scheduling = false;

  // Recipients are tracked as they're added and removed. Reading them only at send time isn't
  // enough: Gmail collapses the recipient chips once you move on to the subject, and the compose
  // DOM may already be gone when the send request is built.
  const tracked = new Map<string, Recipient>();
  composeView.on("recipientsChanged", (e) => {
    for (const kind of ["to", "cc", "bcc"] as const) {
      for (const c of e[kind].added) if (c.emailAddress) tracked.set(c.emailAddress.toLowerCase(), toRecipient(c));
      for (const c of e[kind].removed) if (c.emailAddress) tracked.delete(c.emailAddress.toLowerCase());
    }
  });

  const readRecipients = (): Recipient[] => {
    const found = new Map(tracked);
    try {
      for (const c of [...composeView.getToRecipients(), ...composeView.getCcRecipients(), ...composeView.getBccRecipients()]) {
        if (c.emailAddress) found.set(c.emailAddress.toLowerCase(), toRecipient(c));
      }
    } catch {
      /* compose DOM already gone */
    }
    if (found.size === 0) {
      // Last resort: Gmail's recipient chips carry the address in data-hovercard-id.
      try {
        for (const chip of composeView.getElement().querySelectorAll<HTMLElement>('[role="option"][data-hovercard-id*="@"]')) {
          const email = chip.dataset.hovercardId!;
          const name = chip.dataset.name;
          found.set(email.toLowerCase(), name ? { name, email } : { email });
        }
      } catch {
        /* ignore */
      }
    }
    return [...found.values()];
  };

  // Grab subject/recipients while the compose DOM is intact. Later captures never wipe out what
  // an earlier one found.
  const capture = () => {
    try {
      const recipients = readRecipients();
      const subject = composeView.getSubject();
      captured = {
        sender: ctx.sdk.User.getEmailAddress(),
        subject: subject || captured?.subject || "",
        recipients: recipients.length ? recipients : (captured?.recipients ?? []),
        threadId: composeView.getThreadID() || captured?.threadId || null,
      };
    } catch (err) {
      console.debug("[Seen] couldn't read compose details", err);
    }
  };
  composeView.on("presending", () => {
    scheduling = false; // a normal Send, even if the schedule menu was opened earlier
    capture();
  });
  composeView.on("recipientsChanged", capture);
  // Scheduled sends go out later from Gmail's servers. They aren't tracked (yet), so say so.
  composeView.on("scheduleSendMenuOpening", () => {
    scheduling = true;
    if (enabled && ctx.state().connected) showNotice("scheduled");
  });

  // --- The eye toggle ---------------------------------------------------------------------
  let emitButton: ((d: ReturnType<typeof button>) => void) | null = null;
  const button = () => {
    const st = ctx.state();
    if (!st.connected) {
      return {
        title: "Seen isn't set up in this browser — click to connect",
        iconUrl: dataUrl(eyeSvg(false)),
        type: "MODIFIER" as const,
        orderHint: 100,
        onClick: () => void send({ type: "openOptions" }).catch(() => undefined),
      };
    }
    return {
      title: enabled ? "Read tracking is on for this email (click to turn off)" : "Read tracking is off for this email (click to turn on)",
      iconUrl: dataUrl(eyeSvg(enabled)),
      type: "MODIFIER" as const,
      orderHint: 100,
      onClick: () => {
        enabled = !enabled;
        emitButton?.(button());
        const draft = draftKey(composeView);
        if (draft) void saveChoice(draft, enabled);
      },
    };
  };
  composeView.addButton(
    Kefir.stream<ReturnType<typeof button>, never>((emitter) => {
      emitButton = (d) => emitter.emit(d);
      emitter.emit(button());
      return () => {
        emitButton = null;
      };
    }),
  );
  const refreshButton = () => emitButton?.(button());
  composeButtonRefreshers.add(refreshButton);
  composeView.on("destroy", () => composeButtonRefreshers.delete(refreshButton));

  // Restore an earlier on/off choice for this draft.
  const restore = () => {
    const draft = draftKey(composeView);
    if (!draft) return;
    void loadChoice(draft).then((on) => {
      if (on === null || on === enabled) return;
      enabled = on;
      refreshButton();
    });
  };
  restore();
  setTimeout(restore, 1_000); // the draft id may only appear once Gmail has saved the draft

  // --- The pixel --------------------------------------------------------------------------
  // Runs on the body of Gmail's actual send request. Must never throw or hang: a failure here
  // falls back to sending the email exactly as written.
  const modifier = async ({ body, isPlainText }: { body: string; isPlainText?: boolean }) => {
    modifierRan = true;
    try {
      const st = ctx.state();
      // Always strip old pixels (e.g. ones quoted from earlier emails in this thread).
      const cleaned = st.serverHost ? stripPixels(body, st.serverHost) : body;
      if (!enabled) {
        // Tracking switched off after this window had already sent once (e.g. undo, then re-send).
        if (registered) untrack(ctx, registered.token);
        registered = null;
        return { body: cleaned };
      }
      // From here on you wanted this email tracked, so never fail silently.
      if (scheduling) {
        showNotice("sent-scheduled");
        return { body: cleaned };
      }
      if (!st.connected || !st.serverUrl) {
        showNotice("sent-not-connected");
        return { body: cleaned };
      }
      if (!extensionAlive()) {
        showNotice("sent-stale");
        return { body: cleaned };
      }
      // Gmail's current send path always says "not plain text", so check the body itself: an
      // <img> in a plain-text email would show up as literal text.
      if (isPlainText || isPlainTextBody(cleaned)) {
        showNotice("sent-plain-text");
        return { body: cleaned };
      }

      if (!registered) {
        const token = await ctx.tokens.take(1_500);
        if (!token) {
          showNotice("sent-no-token");
          return { body: cleaned };
        }
        capture();
        const message: PutMessageRequest = {
          sender: captured?.sender ?? ctx.sdk.User.getEmailAddress(),
          subject: captured?.subject ?? "",
          recipients: captured?.recipients.length ? captured.recipients : [...tracked.values()],
          threadId: captured?.threadId ?? null,
          sentAt: Date.now(),
        };
        registered = { token, message };
        recentlySent.set(token, Date.now());
        void send({ type: "register", token, message }).catch((err) => console.warn("[Seen] register failed", err));
        ctx.store.put(optimistic(token, message));
      }
      return { body: insertPixel(cleaned, pixelUrl(st.serverUrl, registered.token)) };
    } catch (err) {
      console.warn("[Seen] pixel injection skipped", err);
      return { body };
    }
  };

  // InboxSDK can only hook a compose window once Gmail has given it a draft id, which a brand-new
  // window may not have yet. Keep trying, and make a last attempt the moment Send is pressed
  // (that still happens before Gmail builds the send request).
  let attached = false;
  const tryAttach = (): boolean => {
    if (attached) return true;
    try {
      composeView.registerRequestModifier(modifier);
      attached = true;
    } catch {
      /* no draft id yet */
    }
    return attached;
  };
  if (!tryAttach()) {
    const started = Date.now();
    const timer = setInterval(() => {
      if (tryAttach() || Date.now() - started > 60_000) clearInterval(timer);
    }, 250);
    composeView.on("destroy", () => clearInterval(timer));
  }
  composeView.on("presending", () => {
    if (!tryAttach() && enabled && ctx.state().connected) showNotice("sent-not-hooked");
  });

  // Once Gmail confirms, record the ids so thread lists and message views can find it.
  composeView.on("sent", (event) => {
    // Safety net: Gmail sent it, tracking was wanted, but our hook never saw the request.
    if (!modifierRan && !scheduling && enabled && ctx.state().connected) showNotice("sent-not-hooked");
    const reg = registered;
    if (!reg) return;
    Promise.all([event.getThreadID(), event.getMessageID()])
      .then(([threadId, messageId]) => {
        if (dropped.has(reg.token)) return; // undone in the meantime
        const message = { ...reg.message, threadId: threadId || reg.message.threadId, messageId };
        ctx.store.put(optimistic(reg.token, message));
        return send({ type: "register", token: reg.token, message });
      })
      .catch((err) => console.debug("[Seen] couldn't read sent ids", err));
  });
}

function toRecipient(c: { emailAddress: string; name?: string | null }): Recipient {
  return c.name ? { name: c.name, email: c.emailAddress } : { email: c.emailAddress };
}

function optimistic(token: string, m: PutMessageRequest): MessageSummary {
  return {
    token,
    sender: m.sender,
    subject: m.subject,
    recipients: m.recipients,
    sentAt: m.sentAt ?? Date.now(),
    threadId: m.threadId ?? null,
    messageId: m.messageId ?? null,
    status: "sent",
    opens: 0,
    firstOpenAt: null,
    lastOpenAt: null,
    lastClient: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Status in thread lists and opened threads
// ---------------------------------------------------------------------------------------------

function watch(store: StatusStore, key: Key): Property<MessageSummary | null, never> {
  return Kefir.stream<MessageSummary | null, never>((emitter) => {
    const emit = () => emitter.emit(store.latest(key));
    const unsubscribe = store.subscribe(key, emit);
    emit();
    return unsubscribe;
  })
    .skipDuplicates(
      (a, b) => a === b || (!!a && !!b && a.token === b.token && a.status === b.status && a.opens === b.opens && a.lastOpenAt === b.lastOpenAt),
    )
    .toProperty();
}

const tooltip = (s: MessageSummary) => `Seen · ${statusLine(s)}`;

export function setupThreadRows(ctx: GmailContext): void {
  ctx.sdk.Lists.registerThreadRowViewHandler((row: ThreadRowView) => {
    if (!ctx.state().connected) return;
    row
      .getThreadIDIfStableAsync()
      .then((threadId) => {
        if (!threadId) return;
        row.addAttachmentIcon(
          watch(ctx.store, `th:${threadId}`).map((s) =>
            s ? { iconUrl: dataUrl(statusSvg(s.status)), tooltip: tooltip(s) } : null,
          ),
        );
      })
      .catch(() => undefined);
  });
}

export function setupMessageViews(ctx: GmailContext, popover: PopoverDeps): void {
  ctx.sdk.Conversations.registerMessageViewHandler((mv: MessageView) => {
    try {
      attachToMessage(ctx, mv, popover);
    } catch (err) {
      console.debug("[Seen] couldn't attach to message", err);
    }
  });
}

function attachToMessage(ctx: GmailContext, mv: MessageView, popover: PopoverDeps): void {
  const st = ctx.state();
  if (!st.connected || !st.serverHost || !st.userId) return;

  // Our own pixel in the message proves it's one of ours — whichever "Send as" address it came
  // from. Without one, only look it up by id if you (this account) sent it.
  const token = ownToken(mv.getBodyElement(), st.serverHost, st.userId);
  if (!token) {
    try {
      if (mv.getSender().emailAddress.toLowerCase() !== ctx.sdk.User.getEmailAddress().toLowerCase()) return;
    } catch {
      return;
    }
  }
  const key: Promise<Key | null> = token
    ? Promise.resolve(`t:${token}` as Key)
    : mv.getMessageIDAsync().then((id) => `m:${id}` as Key, () => null);

  key
    .then((k) => {
      if (!k) return;
      backfill(ctx, mv, k);
      const anchor = `seen-${Math.random().toString(36).slice(2, 10)}`;
      mv.addAttachmentIcon(
        watch(ctx.store, k).map((s) =>
          s
            ? {
                iconHtml:
                  `<span data-seen-anchor="${anchor}" style="display:inline-flex;vertical-align:middle;cursor:pointer">` +
                  `${statusSvg(s.status)}</span>`,
                tooltip: tooltip(s),
                onClick: () => {
                  const el = document.querySelector(`[data-seen-anchor="${anchor}"]`);
                  if (el) showPopover(el, s.token, popover);
                },
              }
            : { iconHtml: "" },
        ),
      );
    })
    .catch((err) => console.debug("[Seen] couldn't add status icon", err));
}

const backfilled = new Set<string>();

/**
 * Fill in what couldn't be recorded at send time — recipients, or Gmail's thread/message ids (e.g.
 * a pop-out window closed before Gmail reported them) — from the sent message itself, the first
 * time it's displayed. Only ever adds information; never touches when it was sent.
 */
function backfill(ctx: GmailContext, mv: MessageView, key: Key): void {
  let done = false;
  const finish = () => {
    done = true;
    unsubscribe();
  };
  const run = () => {
    if (done) return;
    const s = ctx.store.latest(key);
    finish();
    if (!s || backfilled.has(s.token)) return;
    const needRecipients = s.recipients.length === 0;
    const needIds = !s.threadId || !s.messageId;
    if (!needRecipients && !needIds) return;
    backfilled.add(s.token);
    Promise.all([
      needRecipients ? mv.getRecipientsFull().catch(() => []) : Promise.resolve([]),
      needIds ? mv.getMessageIDAsync().catch(() => null) : Promise.resolve(null),
      needIds ? mv.getThreadView().getThreadIDAsync().catch(() => null) : Promise.resolve(null),
    ])
      .then(([people, messageId, threadId]) => {
        const recipients = people.filter((c) => c.emailAddress).map(toRecipient);
        if (!recipients.length && !messageId && !threadId) return;
        const message: PutMessageRequest = {
          sender: s.sender,
          subject: s.subject,
          recipients: recipients.length ? recipients : s.recipients,
          threadId: s.threadId ?? threadId,
          messageId: s.messageId ?? messageId,
        };
        ctx.store.put({ ...s, recipients: message.recipients, threadId: message.threadId ?? null, messageId: message.messageId ?? null });
        return send({ type: "register", token: s.token, message });
      })
      .catch((err) => console.debug("[Seen] couldn't backfill", err));
  };
  const unsubscribe = ctx.store.subscribe(key, run);
  if (ctx.store.latest(key)) run(); // already known: no lookup will fire
  // Don't leave the listener around if the lookup never answers.
  setTimeout(() => {
    if (!done) finish();
  }, 30_000);
}

/** The pixel in this message's own body (not a quoted copy from an earlier message). */
export function ownToken(body: HTMLElement, host: string, userId: string): string | null {
  for (const img of body.querySelectorAll(`img[src*="//${host}/i/"]`)) {
    if (img.closest(".gmail_quote, blockquote")) continue;
    const token = extractToken(img.getAttribute("src") ?? "", host);
    if (token && tokenUserId(token) === userId) return token;
  }
  return null;
}
