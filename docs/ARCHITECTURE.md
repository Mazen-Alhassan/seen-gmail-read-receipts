# Seen: architecture

This document is the design plan: what the pieces are, how an email flows through them, and why each decision was made. It is most useful for the parts that look simple but aren't.

## Goals

1. **Never interfere with sending.** Tracking is best-effort; sending is sacred. No step on the send path may block on the network, throw, or hang.
2. **Don't lie.** A green ✓✓ must mean a person opened it. Machine loads (proxies, prefetchers, scanners, and above all *the sender themself*) are identified and set aside, and the user can see what was set aside and why.
3. **Stay out of the way.** Gmail-native look, no sidebars, no banners, no extra clicks.
4. **Own your data.** A server per user (or team), on a free tier, deployable with one command.

## Components

```
┌──────────────────────────── Chrome ────────────────────────────┐        ┌──────── Cloudflare ─────────┐
│  Gmail tab                                                     │        │  Worker (Hono)              │
│  ┌─────────────────────────────┐   runtime    ┌──────────────┐ │ HTTPS  │   GET  /i/<token>.gif  pixel│
│  │ content script (InboxSDK)   │  messages    │ service      │─┼───────▶│   /api/* (bearer auth)      │
│  │  • compose: eye toggle,     │◀────────────▶│ worker       │ │        │                             │
│  │    request modifier (pixel) │              │  • API client│ │        │  D1 (SQLite)                │
│  │  • thread rows / messages:  │              │  • outbox    │ │        │   users, messages,          │
│  │    status icons, popover    │              │  • poller →  │ │        │   hits (raw), self_views    │
│  │  • self-view beacon         │              │    notifications│      │                             │
│  └─────────────────────────────┘              │  • DNR rule  │ │        │  Cron: orphan + retention   │
│                                               └──────────────┘ │        └─────────────────────────────┘
└────────────────────────────────────────────────────────────────┘                 ▲
                                                                                    │ image request
                                     recipient's mail app / Google image proxy ─────┘
```

**Why a Cloudflare Worker.** A pixel server has one hard requirement: be up and fast at the moment someone opens the email. Free tiers that sleep (Render, and so on) take 30+ seconds to wake, and image proxies give up before that, so opens are silently lost. Workers have no cold starts, run close to every recipient, include a free SQLite database, and fit comfortably in the free plan (100k requests/day).

**Why InboxSDK.** Gmail's DOM is obfuscated and changes without notice. InboxSDK is maintained by Streak (whose product depends on it) and absorbs those changes. It also exposes `registerRequestModifier`, which is the key to goal 1 and the first line of defence for goal 2. Everything InboxSDK-specific lives in `extension/src/content/gmail.ts`, and the rest of the extension is SDK-agnostic.

## The life of a tracked email

```mermaid
sequenceDiagram
  participant U as You (Gmail)
  participant C as Content script
  participant W as Service worker
  participant S as Seen server
  participant R as Recipient's mail app

  Note over C: compose opens → a pre-minted token is ready
  U->>C: Send
  C->>C: Gmail builds the send request → modifier strips old pixels,<br/>inserts <img src=/i/TOKEN.gif> at the top
  C-->>W: register(token, subject, recipients)
  W->>S: PUT /api/messages/TOKEN (queued, retried until it lands)
  S->>S: MX lookup of recipient domains → security gateway?
  C-->>W: 'sent' → register(token, threadId, messageId)
  R->>S: GET /i/TOKEN.gif (UA, IP, ASN recorded raw)
  S-->>R: 1×1 GIF, no-store
  W->>S: GET /api/events?since=… (every 30s)
  S->>S: classify hits → "open"
  S-->>W: Alice opened "Proposal"
  W->>U: notification + badge + toast; ✓ → ✓✓
```

### 1. Tokens: minted offline, verifiable statelessly

A token is 24 bytes (32 base64url characters): `userId(8) ‖ nonce(10) ‖ HMAC-SHA256(mintKey, first 18 bytes)[0..6]`.

- The extension mints tokens itself (WebCrypto), so **sending never waits for the server**. A small pool is kept ready because WebCrypto is async and the send hook shouldn't even wait for that.
- The server can reject forged or junk tokens with no lookup beyond the owner's key (cached per isolate). Every stored hit therefore belongs to a real user.
- Hits that arrive **before** the email is registered (a slow network at send time) are still recorded and join up once the registration lands. A daily cron removes hits whose email was never registered.
- All of one user's tokens share their first 10 characters. That is what lets the extension block *its own* pixels without touching anyone else's (see below).

### 2. The pixel goes into the send request, not the compose window

Inserting an `<img>` into the compose editor, the obvious approach, makes the sender's own browser load it immediately, which is a false "open" before the email even leaves. It also leaves the pixel in drafts. Instead, `composeView.registerRequestModifier` rewrites the HTML body of Gmail's actual send request:

- **Strip** every pixel from our server already in the body. Replies quote earlier emails, pixels included. Without this, replying would re-open your old emails.
- **Insert** the new pixel at the **top**, inside the first block element so it shares the first line and adds no blank line. Gmail clips messages over ~102 KB and never loads anything below the cut, so a bottom pixel in a long thread would silently never fire.
- The modifier is idempotent and wrapped so it can never throw. If it fails, the email goes out exactly as written.
- Markup: `<img width="1" height="1" alt="" style="width:1px;height:1px;border:0">`. It is not `display:none`, which some clients skip. The path `/i/<token>.gif` avoids words like `track`/`open`/`pixel` that blocklists match on.

### 3. Recording: dumb on write, smart on read

`GET /i/:token.gif` answers **immediately** with the GIF and `Cache-Control: no-store` (so Google's proxy comes back for re-opens). The hit is written after the response (`waitUntil`), storing raw facts only: timestamp, IP, User-Agent, ASN and network name, city, country.

Classification happens **on every read**, from the raw hits plus the sender's self-view beacons. This matters because signals arrive out of order: the "that was me" beacon from your browser can land a second after the hit it explains. Anything computed at write time would already be wrong by then. Reads are cheap (one user's handful of hits), and the classifier is a pure, heavily tested function.

### 4. Classification

`server/src/sources.ts` identifies *who* fetched. The strongest signal is the user agent of a real
mail app (Outlook desktop, Apple Mail, Thunderbird…): scanners and sandboxes use browser-like or
tool user agents, so a mail app counts as a person **whatever network it came from** — a VPN, a
corporate web gateway (Zscaler, Netskope…), a cloud PC. Order matters, because the mail proxies all
live on data-centre networks.

| Signal | Source | Counts as |
|---|---|---|
| UA contains `GoogleImageProxy` | Gmail (web + apps) | open |
| Gmail's old-Edge prefetch signature | Gmail delivery prefetch | ignored |
| UA contains `YahooMailProxy` | Yahoo/AOL | open, unless right after delivery (filtering) |
| UA is exactly `Mozilla/5.0` **and** it came from Apple's relays (Cloudflare/Akamai/Fastly/Apple) | Apple Mail Privacy Protection | *unconfirmed* |
| Real mail-app UA | a person reading | open (labelled "via VPN or company network" when relayed) |
| Proton's network | Proton's preloading proxy | *unconfirmed* |
| Mail-security vendor network (Proofpoint, Mimecast, Barracuda, IronPort…) | security gateway | ignored |
| Microsoft's network | Outlook.com/new Outlook for a reader, **or** Microsoft 365 Defender scanning | see below |
| Other Google network, or a hosting/cloud network with a browser-like UA | automation | ignored |
| A corporate web gateway or VPN with a browser-like UA | someone browsing at work | open |
| Anything else | the mail app itself: Outlook desktop, Apple Mail, Thunderbird, webmail | open, with location |

**Microsoft's network needs care**, because both a reader's Outlook and Microsoft's scanners come
from it. Defender's sandbox is recognised by its signature (a frozen Windows Chrome 109) whoever the
recipient is. Otherwise, fetches soon after delivery are treated as filtering: about a minute for
personal Outlook.com/Hotmail mailboxes, 15 minutes for everyone else (a company on Microsoft 365,
where Defender keeps scanning and delivery can be delayed). Later fetches count as opens.

`server/src/classify.ts` then decides what each hit *meant*:

1. **Self**: a Gmail-proxy fetch right around a self-view beacon (see below), or before the email
   could even have been delivered, or of an email you sent only to yourself; or a direct fetch from
   the IP+UA the email was registered from (never on a shared network, where a colleague behind the
   same gateway would look identical).
2. **Bot / prefetch**: per the table above.
3. **Delivery-time scan**: a browser-like direct fetch within a minute of sending. Every window
   allows for Gmail's Undo Send delay (up to 30s between pressing Send and actual delivery). If the
   recipient's MX records point at a security gateway, this window is 3½ minutes.
4. **Repeat**: the same reader again within 3 minutes of the *start* of their reading session (45s
   for a shared proxy when the email had several recipients, so two recipients count separately).
   Proxied reads are grouped by proxy; direct reads by app and network, so one device switching
   between IPv4 and IPv6 isn't two people.
5. Otherwise **open**.

Status: `opened` if any counted open, else `unconfirmed` if a privacy proxy loaded it, else `sent`.

### 5. The sender's own views: three layers

This is the biggest source of false opens for any Gmail tracker. Opening your Sent folder, or a thread containing your message, loads the pixel through Google's proxy, and on the server that looks identical to the recipient opening it.

1. **Block at the source (primary).** A `declarativeNetRequest` rule blocks image requests initiated by `mail.google.com` whose URL contains `<your-server>/i/<your-token-prefix>`. Gmail's proxied image URLs carry the original URL after `#` (`https://ciN.googleusercontent.com/meips/…#https://server/i/TOKEN.gif`), and DNR matches against the full URL including the fragment. This was verified in Chrome, and the end-to-end test checks it on every run. Your own pixel never leaves your browser. Other users' pixels (emails you *receive* from someone on the same server) don't match your prefix, so they load normally.
2. **Beacon (backup).** A `MutationObserver` watches the page for your own pixels, including inside quoted replies, and tells the server "I'm displaying these now". Hits within ±45 s are discounted. This keeps working if Gmail ever changes its proxy URL format.
3. **Settle windows.** The UI ignores hits younger than 8 s, and notifications wait 30 s, so a late beacon can never cause a false alert that later disappears.

The beacon only reports pixels that **actually loaded**. When blocking works there's nothing to
report, so the beacon can't discount a genuine open that lands while you're looking at the thread.

What's left: you viewing your own sent mail on a device without the extension (e.g. the Gmail phone app). Every tracker shares this limit. The Mailtrack-style fix (rewriting the Sent copy) is patented, so it's out of scope.

### 5b. Never failing quietly

A tracker that silently stops tracking is worse than no tracker. Every path that would send an
email untracked raises a message in Gmail at that moment (Seen draws its own, so Gmail's "Message
sent · Undo" bar can neither hide it nor be hidden by it): not connected, the server no longer
accepting this browser's key, the extension updated but this tab still running the old script,
plain-text mode, a scheduled send, no token available, or Gmail sending without passing through the
hook at all. The toolbar icon shows "!" while a browser isn't connected, and on install/update the
service worker refreshes idle Gmail tabs (never the one you're using or typing in — those refresh
themselves once you switch away).

### 6. Delivery guarantees in the extension

- **Outbox** (`background/queue.ts`): registrations go into `chrome.storage` and are retried with exponential backoff (15 s → 30 min cap) across service-worker restarts, offline periods and browser restarts. Updates to the same email merge, and a delete supersedes a pending registration. When the network is down everything backs off together, and 4xx rejections are dropped.
- **Clock skew**: the service worker learns the server's clock from `Date` headers, so `sentAt` (used by the timing rules) is in server time.
- **Stale tabs**: after the extension updates, old content scripts detect the invalidated context and stop injecting pixels. An email is never sent with a pixel that can't be registered.

### 7. Getting status into Gmail cheaply

`content/store.ts` batches every status request made in the same ~120 ms (e.g. 50 thread rows rendering) into **one** `POST /api/messages/lookup` by token, thread id or message id. It caches answers, including "not tracked", for 45 s, and pushes changes to InboxSDK through Kefir streams, so icons update in place. Message views are matched by the pixel in their own (non-quoted) body first, and by Gmail message id as a fallback. The service worker's 30 s poll drives notifications and prompts open tabs to refresh.

## Data model (D1)

| table | purpose |
|---|---|
| `users` | id, SHA-256 of API key (the key itself is never stored), HMAC mint key |
| `messages` | one row per tracked email: sender, subject, recipients (JSON), sent_at, Gmail thread/message ids, registering IP/UA, security gateway |
| `hits` | raw pixel requests, never modified |
| `self_views` | "the sender displayed this" beacons |

Housekeeping (daily cron): drop week-old hits for tokens never registered; purge emails older than `RETENTION_DAYS` (365).

## API

All `/api/*` routes except `register` need `Authorization: Bearer <apiKey>`. CORS is open, which is safe with bearer tokens and no cookies.

| Method & path | |
|---|---|
| `GET /i/<token>.gif` | the pixel |
| `POST /api/register` `{inviteCode}` | create an account → `{userId, apiKey, mintKey}` |
| `GET` / `DELETE /api/me` | whoami / delete account and all data |
| `PUT /api/messages/<token>` | register or update an email (idempotent) |
| `DELETE /api/messages/<token>` | stop tracking, forget history |
| `GET /api/messages?limit&before&sender` | recent emails with status |
| `POST /api/messages/lookup` `{tokens, threadIds, messageIds}` | status for specific emails |
| `GET /api/messages/<token>` | one email with its classified event history |
| `POST /api/self-views` `{tokens, at}` | "I'm displaying these" |
| `GET /api/events?since` | settled opens since cursor → `{events, cursor}` |

## Testing

- **Server**: 45 tests run inside the real Workers runtime (`@cloudflare/vitest-plugin`) against a real D1 database. They cover the classifier with real-world user agents, forged tokens, out-of-order signals, settle windows, the events cursor, CORS, housekeeping, gateway detection, and a guard that the entry module exports only handlers.
- **Extension**: 29 tests (jsdom) for the send-path HTML surgery, the beacon, the status store's batching and caching, the outbox under outages, the token pool and formatting.
- **`scripts/smoke.mjs`**: end-to-end over HTTP against any running server (local or deployed); cleans up after itself.
- **Browser e2e** (run during development): the built extension loaded into Chrome for Testing. It checks install → settings → connect, that the DNR rule blocks the user's own pixel in both direct and Google-proxied form but not other users', that the beacon fires only for the user's own tokens, the badge, and the popup.

What automated tests can't cover is InboxSDK inside a live, logged-in Gmail. See the manual checklist below.

## Manual checklist (live Gmail)

1. Compose → the eye icon appears in the bottom toolbar; clicking it toggles on/off.
2. Send to a second account you can open **on another device** (or in a browser profile without Seen). The thread shows a gray ✓ within seconds.
3. Open your Sent copy on this computer → it stays gray. Check **N ignored** in the popover: nothing, or "You, viewing…".
4. Open the email as the recipient → within ~30–60 s: notification, badge, toast, and a green ✓✓. The popover says "Gmail".
5. Reply in the thread from the recipient side, then open it as the sender → no new open for the first email.
6. Turn tracking off for one email → it doesn't show up in the popup.

## Future work

- **Link click tracking** (opt-in): a stronger signal than opens, especially for Apple Mail users. It needs its own scanner handling (Safe Links and similar tools pre-click links).
- **Per-recipient tracking** for group emails: send individual copies (a different product decision).
- **Chrome Web Store** packaging (`pnpm --filter seen-extension zip`) and a Firefox build.
- **Selector overrides**: InboxSDK ≥ 2.2.19 accepts remote selector overrides, which could hot-patch Gmail DOM changes without an extension update.
