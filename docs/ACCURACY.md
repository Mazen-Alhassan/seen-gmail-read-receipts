# How accurate is it?

Open tracking works by loading a 1×1 invisible image from your server. That's the same technique every email tracker uses, and the hard part is telling a *person opening the email* apart from everything else that loads images. Seen handles the known cases:

| What happens | What Seen does |
|---|---|
| You view your own sent email in Gmail | **Blocked before it loads.** The extension stops your browser from fetching your own pixels, even through Google's image proxy. If one ever loads anyway, it tells the server "that was me". |
| You reply in a thread | Your earlier pixels are stripped from the quoted text, so old emails don't get "re-opened". |
| You email yourself, or CC yourself | Opens of a note to yourself count as you; with others on the email, the open says "could be your own copy". |
| Microsoft 365 companies scan incoming mail (Defender) | Recognised by its signature and by Microsoft's network right after delivery, and ignored — this is why a job application can look "opened" minutes after sending. |
| Gmail preloads images on delivery, Yahoo filters on arrival, Apple Mail / Proton load every email automatically | All recognised and set aside. Apple/Proton show as a **dashed amber ✓✓**: delivered, but a read can't be confirmed. |
| Corporate security gateways (Proofpoint, Mimecast, Barracuda…) | Recognised by network and by the recipient's mail servers (MX records). Early loads are ignored. |
| Your recipient reads through a company web filter or VPN (Zscaler, Netskope, Cloudflare WARP…) | Still counts: a real mail app is a person, whatever network it arrives from. |
| Gmail's Undo Send delay | Timing allows for it, so a scanner that fetches during the delay isn't mistaken for a reader. |
| The same person re-opens within a few minutes | Counted as one open. Several recipients opening close together count separately. |
| Outlook, Yahoo, Thunderbird, Apple Mail, webmail | Identified by name. Location is shown when the app fetches directly, e.g. "Outlook on Windows · Ottawa, CA". |

## Limits

- If the recipient has images turned off, or reads in plain text, no open is recorded. Plain-text emails can't be tracked at all — Seen says so instead of sending one.
- If *you* open your sent email on your phone, it looks like an open, because the extension isn't there to say "that was me".
- Group emails: Seen knows the email was opened, not **which** recipient opened it.
- Scheduled sends aren't tracked; Seen tells you when you open the schedule menu.
- Google caches images, so repeat-open counts are a minimum.
- For a recipient at a **Microsoft 365 company**, reads in the *web* version of Outlook may not be counted, because they're indistinguishable from Microsoft's own scanning. Their Outlook app still counts.

**Seen never fails quietly.** Whenever an email goes out untracked — not connected, extension updated but Gmail not refreshed, plain text, scheduled — it tells you in Gmail at the moment it happens, and the toolbar icon shows "!" in any browser where Seen isn't connected.

The rules behind all of this live in [`server/src/classify.ts`](../server/src/classify.ts) and [`server/src/sources.ts`](../server/src/sources.ts); [ARCHITECTURE.md](ARCHITECTURE.md) explains the reasoning.
