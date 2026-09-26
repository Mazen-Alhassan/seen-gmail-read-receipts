import { describe, expect, it } from "vitest";
import {
  DELIVERY_SCAN_WINDOW_MS,
  GATEWAY_SCAN_WINDOW_MS,
  MICROSOFT_SCAN_WINDOW_MS,
  isMicrosoftConsumer,
  canonicalEmail,
  REPEAT_WINDOW_MS,
  SELF_VIEW_AFTER_MS,
  SELF_VIEW_BEFORE_MS,
  sweepKey,
  classify,
  summarize,
  type Hit,
  type MessageContext,
} from "../src/classify";
import { identify } from "../src/sources";
import { UA } from "./fixtures";



const SENT = 1_700_000_000_000;
const msg: MessageContext = {
  sentAt: SENT,
  senderIp: "203.0.113.9",
  senderUa: UA.chromeMac,
  gateway: null,
  microsoftConsumer: false,
  toSelfOnly: false,
  selfAmongRecipients: false,
  recipientCount: 1,
};

function hit(ts: number, over: Partial<Hit> = {}): Hit {
  return {
    ts,
    ip: "66.249.84.1",
    ua: UA.gmail,
    asn: 15169,
    asOrg: "GOOGLE",
    country: "US",
    region: null,
    city: null,
    ...over,
  };
}

const min = 60_000;
const kinds = (hits: Hit[], views: number[] = []) => classify(msg, hits, views).map((c) => c.kind);

describe("identify", () => {
  it("recognises mail proxies and clients", () => {
    expect(identify({ ua: UA.gmail, asn: 15169, asOrg: "GOOGLE" }).client).toBe("gmail");
    expect(identify({ ua: UA.yahoo, asn: 26101, asOrg: "YAHOO-3" }).client).toBe("yahoo");
    // Apple's privacy relay egresses via Cloudflare/Akamai/Fastly — the bare UA is the signal.
    expect(identify({ ua: UA.applePrivacy, asn: 13335, asOrg: "CLOUDFLARENET" })).toMatchObject({
      via: "privacy_proxy",
      client: "apple_mail",
    });
    expect(identify({ ua: UA.gmailPrefetch, asn: 15169, asOrg: "GOOGLE" }).via).toBe("gmail_prefetch");
    expect(identify({ ua: UA.edge, asn: 8075, asOrg: "MICROSOFT-CORP-MSN-AS-BLOCK" })).toMatchObject({
      via: "outlook_proxy",
      client: "outlook",
      label: "Outlook (via Microsoft)",
    });
    expect(identify({ ua: UA.chromeMac, asn: 62371, asOrg: "Proton AG" }).via).toBe("privacy_proxy");
    expect(identify({ ua: UA.outlookWin, asn: 7922, asOrg: "COMCAST" })).toMatchObject({
      via: "direct",
      client: "outlook",
      label: "Outlook on Windows",
    });
    // Several iOS mail apps share this user agent, so it's labelled honestly.
    expect(identify({ ua: UA.appleMailIphone, asn: 812, asOrg: "ROGERS" })).toMatchObject({
      client: "apple_mail",
      label: "Mail app on iPhone",
    });
    expect(identify({ ua: UA.appleMailMac, asn: 812, asOrg: "ROGERS" }).client).toBe("apple_mail");
    expect(identify({ ua: UA.thunderbird, asn: 812, asOrg: "ROGERS" }).client).toBe("thunderbird");
    expect(identify({ ua: UA.chromeMac, asn: 812, asOrg: "ROGERS" }).client).toBe("webmail");
  });

  it("flags automation", () => {
    expect(identify({ ua: UA.curl, asn: 812, asOrg: "ROGERS" }).via).toBe("scanner");
    expect(identify({ ua: "", asn: 812, asOrg: "ROGERS" }).via).toBe("scanner");
    expect(identify({ ua: UA.chromeMac, asn: 16509, asOrg: "AMAZON-02" }).via).toBe("scanner");
    expect(identify({ ua: UA.chromeMac, asn: 30031, asOrg: "Mimecast Services Limited" })).toMatchObject({
      via: "scanner",
      label: "Security scanner (Mimecast)",
    });
    expect(identify({ ua: UA.edge, asn: 22843, asOrg: "PROOFPOINT-ASN-US-WEST" }).via).toBe("scanner");
    // A real browser UA on Apple's own network is just someone on Apple's network, not MPP.
    expect(identify({ ua: UA.chromeMac, asn: 714, asOrg: "APPLE-ENGINEERING" }).via).toBe("direct");
    // Google's network but not the image proxy → Google's own scanning, not a person.
    expect(identify({ ua: UA.chromeMac, asn: 15169, asOrg: "GOOGLE" }).via).toBe("scanner");
  });
});

describe("canonicalEmail", () => {
  it("matches Gmail addresses however they're written", () => {
    expect(canonicalEmail(" Jane.Doe+work@GMAIL.com")).toBe(canonicalEmail("janedoe@googlemail.com"));
    expect(canonicalEmail("jane.doe@kinaxis.com")).not.toBe(canonicalEmail("janedoe@kinaxis.com"));
  });
});

describe("classify", () => {
  it("counts a Gmail open", () => {
    const c = classify(msg, [hit(SENT + 5 * min)], []);
    expect(c.map((x) => x.kind)).toEqual(["open"]);
    expect(summarize(c)).toEqual({
      status: "opened",
      opens: 1,
      firstOpenAt: SENT + 5 * min,
      lastOpenAt: SENT + 5 * min,
      lastClient: "gmail",
    });
  });

  it("treats a Gmail-proxy hit right around a self-view beacon as the sender", () => {
    const t = SENT + 10 * min;
    expect(kinds([hit(t)], [t - 2_000])).toEqual(["self"]); // fetch lands just after the render
    expect(kinds([hit(t)], [t + 1_000])).toEqual(["self"]); // beacon arrives a moment late
    expect(kinds([hit(t)], [t - SELF_VIEW_AFTER_MS - 1])).toEqual(["open"]);
    expect(kinds([hit(t)], [t + SELF_VIEW_BEFORE_MS + 1])).toEqual(["open"]);
    expect(summarize(classify(msg, [hit(t)], [t])).status).toBe("sent");
  });

  // Regression: opened on an iPhone, then the sender checked their Sent folder 22s later.
  it("never lets a later glance at your Sent folder erase someone else's open", () => {
    const iphone = {
      ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      ip: "2605:b100:d04:af68::1",
      asn: 577,
      asOrg: "Bell Mobility, Inc.",
      city: "Montréal",
      country: "CA",
    };
    const open = SENT + 51_000;
    // The 77ms twin is the same fetch (mail apps ask twice while rendering), so it collapses.
    const c = classify(msg, [hit(open, iphone), hit(open + 77, iphone)], [open + 22_000, open + 72_000]);
    expect(c.map((x) => x.kind)).toEqual(["open"]);
    expect(c[0]!.detail).toBe("Mail app on iPhone · Montréal, CA");
    // Even right on top of a beacon, a non-Gmail fetch can't be the sender's Gmail.
    expect(kinds([hit(open, iphone)], [open])).toEqual(["open"]);
  });

  it("keeps Gmail opens that happen while you're flicking back and forth", () => {
    // Recipient opens in the Gmail app; you look at your Sent folder 13s and 14s either side.
    const t = SENT + 10 * min;
    expect(kinds([hit(t)], [t - 13_000, t + 14_000])).toEqual(["open"]);
  });

  it("ignores the sender's own browser fetching the pixel directly", () => {
    const own = hit(SENT + 30 * min, { ip: msg.senderIp, ua: UA.chromeMac, asn: 812, asOrg: "ROGERS" });
    expect(kinds([own])).toEqual(["self"]);
  });

  it("collapses repeat fetches from the same reader into one open", () => {
    const hits = [
      hit(SENT + 10 * min),
      hit(SENT + 10 * min + 20_000),
      hit(SENT + 10 * min + 2 * min), // sliding window: still the same session
      hit(SENT + 10 * min + 2 * min + REPEAT_WINDOW_MS + 1), // a later, separate open
    ];
    const c = classify(msg, hits, []);
    expect(c.map((x) => x.kind)).toEqual(["open", "repeat", "repeat", "open"]);
    const s = summarize(c);
    expect(s.opens).toBe(2);
    expect(s.lastOpenAt).toBe(hits[3]!.ts);
  });

  it("treats different readers separately", () => {
    const outlook = hit(SENT + 10 * min + 1_000, { ua: UA.outlookWin, ip: "198.51.100.7", asn: 7922, asOrg: "COMCAST" });
    expect(kinds([hit(SENT + 10 * min), outlook])).toEqual(["open", "open"]);
  });

  it("reports Apple privacy prefetches as unconfirmed, not opened", () => {
    const c = classify(msg, [hit(SENT + 30_000, { ua: UA.applePrivacy, asn: 36183, asOrg: "AKAMAI-AS" })], []);
    expect(c[0]!.kind).toBe("prefetch");
    expect(summarize(c)).toMatchObject({ status: "unconfirmed", opens: 0 });
  });

  it("ignores Gmail's delivery prefetch but still counts the real open after it", () => {
    const c = classify(msg, [hit(SENT + 4_000, { ua: UA.gmailPrefetch }), hit(SENT + 30 * min)], []);
    expect(c.map((x) => x.kind)).toEqual(["prefetch", "open"]);
    expect(summarize(c)).toMatchObject({ status: "opened", opens: 1 });
    // A prefetch alone doesn't make the email look "delivered to a privacy proxy".
    expect(summarize(c.slice(0, 1)).status).toBe("sent");
  });

  it("counts Outlook.com opens through Microsoft's servers for personal Outlook/Hotmail addresses", () => {
    const outlook = { ua: UA.edge, asn: 8075, asOrg: "MICROSOFT-CORP-MSN-AS-BLOCK", city: "Redmond", country: "US" };
    const personal = { ...msg, microsoftConsumer: true };
    expect(classify(personal, [hit(SENT + 10 * min, outlook)], []).map((x) => [x.kind, x.detail])).toEqual([
      ["open", "Outlook (via Microsoft)"],
    ]);
    expect(classify(personal, [hit(SENT + MICROSOFT_SCAN_WINDOW_MS - 1, outlook)], [])[0]!.kind).toBe("bot");
  });

  // Regression: an application email to a company on Microsoft 365 showed "Opened 2 times" within
  // minutes. It was Defender scanning it: frozen Chrome 109, several Microsoft data centres.
  it("treats Microsoft-network fetches for company (Microsoft 365) recipients as security scans", () => {
    const defender = (ip: string, city: string) => ({
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
      ip,
      asn: 8075,
      asOrg: "Microsoft Corporation",
      city,
      country: "US",
    });
    const c = classify(
      msg,
      [hit(SENT + 24_000, defender("72.153.231.16", "San Jose")), hit(SENT + 220_000, defender("74.179.68.35", "Moses Lake")), hit(SENT + 307_000, defender("74.179.68.15", "Moses Lake"))],
      [SENT + 188_000],
    );
    expect(c.map((x) => x.kind)).toEqual(["bot", "bot", "bot"]);
    expect(c[0]!.detail).toBe("Microsoft 365 security scan (ignored)");
    expect(summarize(c)).toMatchObject({ status: "sent", opens: 0 });
    // …while that company's reader opening in their own Outlook app still counts.
    const desktop = hit(SENT + 2 * 3600_000, { ua: UA.outlookWin, ip: "198.51.100.7", asn: 7922, asOrg: "COMCAST", city: "Ottawa", country: "CA" });
    expect(classify(msg, [desktop], [])[0]!.kind).toBe("open");
  });

  it("counts real mail apps even through VPNs and corporate web gateways", () => {
    const zscalerOutlook = { ua: UA.outlookWin, ip: "165.225.0.1", asn: 22616, asOrg: "ZSCALER, INC.", city: "Toronto", country: "CA" };
    const warpAppleMail = { ua: UA.appleMailMac, ip: "104.28.0.1", asn: 13335, asOrg: "CLOUDFLARENET", city: "Ottawa", country: "CA" };
    const c = classify(msg, [hit(SENT + 10 * min, zscalerOutlook), hit(SENT + 30 * min, warpAppleMail)], []);
    expect(c.map((x) => [x.kind, x.detail])).toEqual([
      ["open", "Outlook on Windows (via VPN or company network)"],
      ["open", "Apple Mail on Mac (via VPN or company network)"],
    ]);
    // A browser through a corporate web gateway is an employee browsing (gateways don't scan mail);
    // a browser from a cloud/hosting network is automation.
    expect(kinds([hit(SENT + 10 * min, { ...zscalerOutlook, ua: UA.chromeMac })])).toEqual(["open"]);
    expect(kinds([hit(SENT + 10 * min, { ...zscalerOutlook, ua: UA.chromeMac, asn: 16509, asOrg: "AMAZON-02" })])).toEqual(["bot"]);
    // Outlook mobile fetching through Microsoft's network is a person, even for company recipients.
    const outlookIos = { ua: "Outlook-iOS/2.0", ip: "40.97.1.1", asn: 8075, asOrg: "MICROSOFT-CORP-MSN-AS-BLOCK", city: null, country: "US" };
    expect(kinds([hit(SENT + 10 * min, outlookIos)])).toEqual(["open"]);
  });

  it("treats Yahoo's proxy in the first minute as delivery filtering", () => {
    const yahoo = { ua: UA.yahoo, ip: "98.138.1.1", asn: 26101, asOrg: "YAHOO-3" };
    expect(kinds([hit(SENT + 20_000, yahoo)])).toEqual(["bot"]);
    expect(kinds([hit(SENT + 5 * min, yahoo)])).toEqual(["open"]);
  });

  it("knows when you're a recipient yourself", () => {
    expect(classify({ ...msg, toSelfOnly: true }, [hit(SENT + 5 * min)], []).map((x) => x.kind)).toEqual(["self"]);
    expect(classify({ ...msg, selfAmongRecipients: true }, [hit(SENT + 5 * min)], [])[0]).toMatchObject({
      kind: "open",
      detail: "Gmail (could be your own copy)",
    });
  });

  it("doesn't count anything before the email could have been delivered", () => {
    expect(kinds([hit(SENT + 2_000)])).toEqual(["self"]);
  });

  it("recognises Microsoft Defender by its signature, whoever the recipient is", () => {
    const defender = {
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
      asn: 8075,
      asOrg: "Microsoft Corporation",
    };
    const personal = { ...msg, microsoftConsumer: true };
    expect(classify(personal, [hit(SENT + 3 * 3600_000, defender)], [])[0]!.kind).toBe("bot");
  });

  it("counts a Gmail user reading in new Outlook once past Microsoft's scanning window", () => {
    // New Outlook for Windows loads images for Gmail accounts through Microsoft's servers too.
    const newOutlook = { ua: UA.edge, asn: 8075, asOrg: "Microsoft Corporation" };
    expect(kinds([hit(SENT + 5 * min, newOutlook)])).toEqual(["bot"]);
    expect(kinds([hit(SENT + 2 * 3600_000, newOutlook)])).toEqual(["open"]);
  });

  it("only treats a bare Mozilla/5.0 as Apple's privacy proxy when it comes from Apple's relays", () => {
    expect(identify({ ua: "Mozilla/5.0", asn: 36183, asOrg: "Akamai" }).via).toBe("privacy_proxy");
    expect(identify({ ua: "Mozilla/5.0", asn: 16509, asOrg: "AMAZON-02" }).via).toBe("scanner");
  });

  it("doesn't mistake unrelated organisations for scanners or clouds", () => {
    for (const org of ["City and County of San Francisco", "Dawson College", "Preset Networks", "Sagarika Telecom", "Cogent Communications"]) {
      expect(identify({ ua: UA.chromeMac, asn: 1, asOrg: org }).via).toBe("direct");
    }
    expect(identify({ ua: "Mozilla/5.0 (Linux; Android 13; CUBOT P50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36", asn: 1, asOrg: "Rogers" }).via).toBe("direct");
    expect(identify({ ua: "Googlebot/2.1 (+http://www.google.com/bot.html)", asn: 1, asOrg: "x" }).via).toBe("scanner");
  });

  it("counts two Gmail recipients opening a minute apart as two opens", () => {
    const two = { ...msg, recipientCount: 2 };
    expect(classify(two, [hit(SENT + 5 * min), hit(SENT + 6 * min)], []).map((x) => x.kind)).toEqual(["open", "open"]);
    // One recipient: the same reader re-rendering.
    expect(kinds([hit(SENT + 5 * min), hit(SENT + 6 * min)])).toEqual(["open", "repeat"]);
  });

  it("anchors a reading session at its start, so a steady trickle isn't one endless open", () => {
    const hits = [0, 2, 4, 6, 8].map((m) => hit(SENT + 10 * min + m * min));
    expect(kinds(hits)).toEqual(["open", "repeat", "open", "repeat", "open"]);
  });

  it("treats one device switching between IPv4 and IPv6 as one reader", () => {
    const a = { ua: UA.appleMailIphone, ip: "2605:b100:d04:af68::1", asn: 577, asOrg: "Bell Mobility" };
    const b = { ...a, ip: "142.1.2.3" };
    expect(kinds([hit(SENT + 5 * min, a), hit(SENT + 5 * min + 2_000, b)])).toEqual(["open", "repeat"]);
  });

  it("recognises personal Microsoft mailboxes", () => {
    expect(["a@hotmail.com", "b@outlook.com", "c@live.ca", "d@hotmail.co.uk", "e@msn.com"].every(isMicrosoftConsumer)).toBe(true);
    expect(["f@kinaxis.com", "g@gmail.com", "h@outlook-mail.com", "i@myhotmail.com"].some(isMicrosoftConsumer)).toBe(false);
  });

  it("gives gateway-protected recipients a longer scanner window", () => {
    const gated = { ...msg, gateway: "Proofpoint" };
    const browser = { ua: UA.chromeMac, ip: "198.51.100.7", asn: 7922, asOrg: "COMCAST" };
    expect(classify(gated, [hit(SENT + 90_000, browser)], []).map((x) => [x.kind, x.detail])).toEqual([
      ["bot", "Security scanner (Proofpoint) (ignored)"],
    ]);
    expect(classify(gated, [hit(SENT + GATEWAY_SCAN_WINDOW_MS + 1, browser)], [])[0]!.kind).toBe("open");
    // Gmail's proxy only fetches on a real open, gateway or not; and a real mail app is a person.
    expect(classify(gated, [hit(SENT + 90_000)], [])[0]!.kind).toBe("open");
    expect(classify(gated, [hit(SENT + 90_000, { ...browser, ua: UA.outlookWin })], [])[0]!.kind).toBe("open");
  });

  it("treats a browser-like direct fetch right after sending as a delivery-time scanner", () => {
    const fast = { ua: UA.chromeMac, ip: "198.51.100.7", asn: 7922, asOrg: "COMCAST" };
    expect(kinds([hit(SENT + 3_000, fast)])).toEqual(["bot"]);
    // Gmail holds the email for Undo Send (up to 30s), so a scan 34s after pressing Send is still delivery-time.
    expect(kinds([hit(SENT + 34_000, fast)])).toEqual(["bot"]);
    expect(kinds([hit(SENT + DELIVERY_SCAN_WINDOW_MS + 1_000, fast)])).toEqual(["open"]);
    // A real mail app opening quickly is a person (e.g. you testing on your phone).
    expect(kinds([hit(SENT + 30_000, { ...fast, ua: UA.appleMailIphone })])).toEqual(["open"]);
    // Gmail's proxy fetches only when someone actually opens the message.
    expect(kinds([hit(SENT + 8_000)])).toEqual(["open"]);
  });

  it("shows location only for direct fetches", () => {
    const c = classify(
      msg,
      [
        hit(SENT + 5 * min, { city: "Mountain View", country: "US" }),
        hit(SENT + 50 * min, { ua: UA.outlookWin, ip: "198.51.100.7", asn: 7922, asOrg: "COMCAST", city: "Ottawa", country: "CA" }),
      ],
      [],
    );
    expect(c.map((x) => x.detail)).toEqual(["Gmail", "Outlook on Windows · Ottawa, CA"]);
  });

  it("is independent of input order", () => {
    const hits = [hit(SENT + 50 * min), hit(SENT + 10 * min), hit(SENT + 11 * min)];
    const a = classify(msg, hits, []).map((c) => [c.hit.ts, c.kind]);
    const b = classify(msg, [...hits].reverse(), []).map((c) => [c.hit.ts, c.kind]);
    expect(a).toEqual(b);
  });

  it("ignores one mail app pulling several of your emails at once", () => {
    // Your phone rendering replies that quote your original message: one address, one instant,
    // several different emails. The server marks those hits before classifying.
    const at = SENT + 3 * 24 * 60 * 60_000;
    const relay = { ts: at, ip: "2a09:bac3::1", ua: UA.applePrivacy, asn: 13335, asOrg: "Cloudflare London, LLC" };
    const swept = { ...msg, sweptHits: new Set([sweepKey(relay)]) };

    expect(classify(swept, [hit(at, relay)], []).map((c) => c.kind)).toEqual(["self"]);
    expect(summarize(classify(swept, [hit(at, relay)], [])).status).toBe("sent");
    // Without that mark it would claim the recipient's mail app had loaded it.
    expect(summarize(classify(msg, [hit(at, relay)], [])).status).toBe("unconfirmed");
  });

  it("counts a mail app asking twice while rendering as one fetch", () => {
    const mac = { ua: UA.appleMailMac, ip: "47.149.170.15", asn: 5650, asOrg: "Verizon Business" };
    const at = SENT + 3 * 60 * 60_000;
    expect(kinds([hit(at, mac), hit(at, mac)])).toEqual(["open"]);
    expect(kinds([hit(at, mac), hit(at + 1_500, mac)])).toEqual(["open"]);
    // Far enough apart it is a genuine second look, and a different reader always counts.
    expect(kinds([hit(at, mac), hit(at + 5_000, mac)])).toEqual(["open", "repeat"]);
    expect(kinds([hit(at, mac), hit(at, { ...mac, ip: "198.51.100.7", asn: 7922, asOrg: "COMCAST" })])).toEqual([
      "open",
      "open",
    ]);
  });
});