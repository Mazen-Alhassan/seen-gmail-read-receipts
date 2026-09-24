# Setting up Seen

## Setup (about 5 minutes)

You need: **Node 22.18+**, **pnpm**, **Google Chrome** (or Edge/Brave/Arc) and a **free Cloudflare account**.

```sh
pnpm install
pnpm run deploy-server
```

`deploy-server`:
1. logs you in to Cloudflare;
2. creates the database and deploys the server;
3. generates an **invite code**, so only your extension can use your server;
4. asks for an **InboxSDK app id**. It's free and instant at <https://register.inboxsdk.com>. Without one, Gmail shows a small developer warning bar;
5. builds the extension, pre-configured with your server's address.

Then:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `extension/dist`.
2. Seen's settings page opens. Paste the invite code it printed and click **Connect**.
3. Reload Gmail and send an email.

To update later, `git pull && pnpm install && pnpm run deploy-server` (it reuses everything), then click ↻ on the extension in `chrome://extensions` **and refresh your Gmail tabs**. Until you refresh, Gmail shows a "Seen was updated" bar and emails go out untracked.

### Using more than one browser

Connect the second browser to the **same account**, not a new one: in the first browser open Seen's settings → **Copy connection code**, then in the other browser's Seen settings choose **Already use Seen in another browser?** and paste it. Both browsers then share one list, and neither counts your own views as opens. (With separate accounts, reading your own sent email in the other browser would look like an open.)

### Use your own domain (recommended)

Some privacy filters block images from `*.workers.dev`. If you have a domain on Cloudflare:

```sh
pnpm run deploy-server -- --domain seen.yourdomain.com
```

Then reconnect the extension to the new address.

---

## Development

```sh
pnpm check                       # typecheck + all tests + build
pnpm dev:server                  # local server on http://127.0.0.1:8787 (needs server/.dev.vars)
pnpm smoke http://127.0.0.1:8787 <invite-code>   # end-to-end check against any server
pnpm --filter seen-extension watch               # rebuild the extension on change
```

For a local server, run `pnpm --filter seen-server db:migrate:local` once (and again after `deploy-server`, which points the config at your real database) and create `server/.dev.vars` containing `INVITE_CODE=anything`.

```
server/      Cloudflare Worker (Hono + D1): pixel endpoint, API, open classification
extension/   Chrome MV3 extension (InboxSDK): compose hook, Gmail UI, popup, settings
shared/      Token format and API types used by both
scripts/     setup (deploy), smoke test, icon generator
docs/        ARCHITECTURE.md: design, decisions and trade-offs
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it all fits together.

## Troubleshooting

- **An email didn't get a check mark.** Seen now tells you whenever an email goes out untracked (a bar at the bottom of Gmail), and the toolbar icon shows **!** in any browser where Seen isn't connected. The usual causes: you sent from a browser where Seen isn't connected, or the extension was updated and Gmail wasn't refreshed.
- **No check marks in Gmail.** Reload the Gmail tab after installing or updating the extension, and make sure the settings page says *Connected*.
- **"InboxSDK Developer Warning" bar.** Set `INBOXSDK_APP_ID` in `extension/.env`, run `pnpm build`, and reload the extension.
- **An email never shows as opened.** Click its check mark and choose **N ignored** to see everything that loaded the pixel and why each load was discounted. If nothing is listed at all, the recipient's mail app didn't load images.
- **Server logs.** `cd server && npx wrangler tail`.
